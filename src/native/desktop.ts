/**
 * Desktop-only behaviour (Electron): keeps the library in sync with
 * ~/.wosu/Songs and ~/.wosu/Skins, and offers app updates.
 */
import type { Game } from '../app/Game';
import { Bindable } from '../core/Bindable';
import { toggleAudioDebug } from '../debug/AudioDebug';
import { toggleInputDebug } from '../debug/InputDebug';
import { LazerLibrary } from './lazer';
import { native, nativeError, type DisplayMode, type InboxEntry, type MenuAction, type UpdateInfo, type WosuNative } from './native';

export const isDesktop = !!native;

/**
 * Window and Chromium preferences, stored by the shell in
 * ~/.wosu/desktop.json (they apply before the game loads).
 */
class DesktopSettings {
    readonly displayMode: Bindable<DisplayMode>;
    readonly vsync: Bindable<boolean>;
    /** Render at the screen's full Retina density (off: 1 pixel per point). */
    readonly hidpi: Bindable<boolean>;
    /** vsync as the running process was started with. */
    readonly launchedWithVsync: boolean;
    readonly restartRequired = new Bindable(false);
    /** 'darwin' | 'win32' | 'linux'. */
    readonly platform: string;
    readonly host: 'sdl' | 'electron';
    /** The fullscreen kind F11 switches to (the last one picked). */
    private lastFullscreen: Exclude<DisplayMode, 'windowed'> = 'borderless';

    constructor(private readonly native: WosuNative) {
        const c = native.config.initial;
        this.platform = native.platform;
        this.host = native.host ?? 'electron';
        this.displayMode = new Bindable<DisplayMode>(c.displayMode);
        this.vsync = new Bindable(c.vsync);
        this.hidpi = new Bindable(c.hidpi);
        this.launchedWithVsync = c.vsync;
        if (c.displayMode !== 'windowed') this.lastFullscreen = c.displayMode;
        this.displayMode.bind(mode => {
            if (mode !== 'windowed') this.lastFullscreen = mode;
            void native.config.set({ displayMode: mode });
        });
        this.vsync.bind(v => {
            this.restartRequired.value = v !== this.launchedWithVsync;
            void native.config.set({ vsync: v });
        });
        this.hidpi.bind(v => void native.config.set({ hidpi: v }));
        // Changed from outside the game (green button, Ctrl+Cmd+F).
        native.config.onChanged(next => { this.displayMode.value = next.displayMode; });
    }

    toggleFullscreen(): void {
        this.displayMode.value = this.displayMode.value === 'windowed' ? this.lastFullscreen : 'windowed';
    }

    relaunch(): void {
        void this.native.relaunch();
    }
}

export const desktopSettings: DesktopSettings | null = native ? new DesktopSettings(native) : null;

/**
 * Imports whatever the player put into the Songs/Skins folders (archives
 * or extracted folders), and forgets sets/skins whose files were deleted
 * there. Runs at startup and whenever the folders change.
 */
class FolderSync {
    private running: Promise<void> | null = null;
    private again = false;

    constructor(private readonly game: Game, private readonly native: WosuNative) {}

    start(): void {
        this.native.inbox.onChanged(() => this.request());
        this.request();
    }

    request(): void {
        if (this.running) {
            this.again = true;
            return;
        }
        this.running = this.run()
            .catch(e => console.warn('[desktop] folder sync failed', e))
            .finally(() => {
                this.running = null;
                if (this.again) {
                    this.again = false;
                    this.request();
                }
            });
    }

    private async run(): Promise<void> {
        const { game } = this;
        await Promise.all([game.library.init(), game.skins.store.init()]);
        await this.prune();
        const entries = await this.native.inbox.list();
        if (entries.length) await this.importEntries(entries);
    }

    /** Files removed from the folders by hand: drop them from the game too. */
    private async prune(): Promise<void> {
        const { library, skins } = this.game;
        const songs = new Set(await this.native.db.keys('webosu', 'blobs'));
        for (const set of [...library.sets]) {
            // External (osu!lazer) sets have no file here by design.
            if (!songs.has(set.key) && !library.external?.owns(set.key)) await library.delete(set.key);
        }
        const skinFiles = new Set(await this.native.db.keys('wosu-skins', 'files'));
        for (const s of [...skins.store.list]) {
            if (!skinFiles.has(s.id) && !lazerLibrary?.owns(s.id) && !s.id.startsWith('lazer-')) await skins.deleteSkin(s.id);
        }
    }

    private async importEntries(entries: InboxEntry[]): Promise<void> {
        const { game } = this;
        const files: { entry: InboxEntry; file: File }[] = [];
        for (const entry of entries) {
            try {
                const bytes = await this.native.inbox.read(entry.path);
                files.push({ entry, file: new File([bytes as Uint8Array<ArrayBuffer>], entry.name) });
            } catch (e) {
                game.notifications.error(`${entry.name}: ${nativeError(e)}`);
            }
        }
        if (!files.length) return;
        const { skins, beatmaps, rejected } = await game.skins.partition(files.map(f => f.file));
        const entryOf = (file: File) => files.find(f => f.file === file)!.entry;
        for (const f of rejected) game.notifications.error(`${f.name}: not a beatmap or skin`);

        const n = game.notifications.progress(`Importing ${files.length} file${files.length > 1 ? 's' : ''} from ~/.wosu…`);
        n.progress.value = 0;
        let done = 0, ok = 0;
        let firstSet: Awaited<ReturnType<Game['library']['importOsz']>> | null = null;
        const step = () => { n.progress.value = ++done / files.length; };

        for (const file of beatmaps) {
            try {
                const set = await game.library.importOsz(file, { filename: file.name });
                firstSet ??= set;
                ok++;
                await this.native.inbox.done(entryOf(file).path);
            } catch (e) {
                game.notifications.error(`${file.name}: ${nativeError(e)}`);
            }
            step();
        }
        for (const file of skins) {
            try {
                await game.skins.importSkin(file, file.name);
                ok++;
                await this.native.inbox.done(entryOf(file).path);
            } catch (e) {
                game.notifications.error(`${file.name}: ${nativeError(e)}`);
            }
            step();
        }
        if (ok) {
            const set = firstSet;
            n.complete(`Imported ${ok} item${ok > 1 ? 's' : ''} from ~/.wosu`, set ? () => game.selectAndShow(set) : undefined);
        } else {
            n.fail('Nothing could be imported from ~/.wosu.');
        }
    }
}

/** Update checks and the one-click install. */
export class DesktopUpdater {
    info: UpdateInfo | null = null;
    private installing = false;

    constructor(private readonly game: Game, private readonly native: WosuNative) {}

    async check(): Promise<UpdateInfo> {
        this.info = await this.native.update.check();
        return this.info;
    }

    /** Download, install and relaunch, with a progress notification. */
    async install(): Promise<void> {
        if (this.installing) return;
        this.installing = true;
        const { notifications } = this.game;
        const n = notifications.progress(`Downloading wosu! ${this.info?.latest ?? 'update'}…`);
        n.progress.value = 0;
        const off = this.native.update.onProgress(p => {
            if (p.phase === 'download') n.progress.value = p.total ? (p.received ?? 0) / p.total : NaN;
            else if (p.phase === 'extract') {
                n.text.value = 'Unpacking update…';
                n.progress.value = NaN;
            } else n.text.value = 'Restarting…';
        });
        try {
            await this.native.update.install();
        } catch (e) {
            n.fail(`Update failed: ${nativeError(e)}`);
            this.installing = false;
        } finally {
            off();
        }
    }

    /** Ask, then install. */
    async offer(): Promise<void> {
        const info = this.info;
        if (!info?.available) return;
        const yes = await this.game.dialog.confirm({
            title: `Update to wosu! ${info.latest}?`,
            text: `You have ${info.current}. The game will restart; your beatmaps, skins and scores in ~/.wosu are kept.`,
            confirmText: 'Update and restart',
        });
        if (yes) await this.install();
    }

    /** "Check for updates" (settings button, menu bar): report the result, offer an install. */
    async checkInteractive(): Promise<void> {
        const { notifications } = this.game;
        try {
            const info = await this.check();
            if (info.available) {
                if (!info.packaged) notifications.warning('Updates install only in the packaged app.');
                else await this.offer();
            } else if (info.error) {
                notifications.info(`wosu! ${info.current}: ${info.error}.`);
            } else {
                notifications.info(`wosu! ${info.current} is the latest version.`);
            }
        } catch (e) {
            notifications.error(`Update check failed: ${nativeError(e)}`);
        }
    }

    /** Silent startup check: a notification to click when an update exists. */
    async checkInBackground(): Promise<void> {
        try {
            const info = await this.check();
            if (info.available && info.packaged) {
                this.game.notifications.info(`wosu! ${info.latest} is available. Click to update.`, () => void this.offer());
            }
        } catch (e) {
            console.warn('[desktop] update check failed', e);
        }
    }
}

/**
 * The game as a Mac app: menu bar actions, window title, dock progress
 * for downloads, system notifications, media keys and Now Playing, and
 * keeping the display awake during play.
 */
class MacIntegration {
    private playing = false;

    constructor(private readonly game: Game, private readonly native: WosuNative) {}

    async start(): Promise<void> {
        const { game, native } = this;
        native.onMenu(action => this.onMenu(action));
        native.onFileSaved(f => {
            const name = f.path.slice(f.path.lastIndexOf('/') + 1);
            game.notifications.success(`Saved ${name} to ~/.wosu/${f.folder}. Click to show in Finder.`, () => void native.showInFolder(f.path));
        });
        native.onOpenFile(f => void game.importFiles([new File([f.bytes as Uint8Array<ArrayBuffer>], f.name)]));
        this.trackDownloads();
        this.mediaKeys();
        this.throttleWhenUnfocused();

        // Lazy: PlayerScreen pulls in all of gameplay.
        const { PlayerScreen } = await import('../screens/play/PlayerScreen');
        const refresh = () => {
            const playing = game.screens.current instanceof PlayerScreen;
            if (playing !== this.playing) {
                this.playing = playing;
                native.setPlaying(playing);
            }
            this.updateTitle();
        };
        game.screens.changed.add(refresh);
        game.music.current.bind(refresh);
        refresh();
    }

    private onMenu(action: MenuAction): void {
        const { game } = this;
        switch (action) {
            case 'settings':
                if (game.screens.current?.allowOverlays !== false) game.settingsOverlay.toggle();
                break;
            case 'checkUpdates':
                void desktopUpdater?.checkInteractive();
                break;
            case 'import':
                game.pickFiles();
                break;
            case 'openReplay':
                game.pickFiles('.osr');
                break;
            case 'reloadLazer':
                void lazerLibrary?.sync();
                break;
            case 'fullscreen':
                game.toggleFullscreen();
                break;
            case 'debugAudio':
                toggleAudioDebug();
                break;
            case 'debugInput':
                toggleInputDebug();
                break;
        }
    }

    /**
     * Without a frame limit the game renders as fast as it can, and macOS's
     * compositor has to take every frame: the whole system stutters, even
     * with wosu! in the background. Behind other windows, 30 fps is plenty.
     */
    private throttleWhenUnfocused(): void {
        const { game } = this;
        const BACKGROUND_FPS = 30;
        const apply = () => {
            const focused = document.hasFocus() && document.visibilityState === 'visible';
            const limit = game.settings.frameLimit.value;
            game.app.setMaxFps(focused ? limit : limit > 0 ? Math.min(limit, BACKGROUND_FPS) : BACKGROUND_FPS);
        };
        window.addEventListener('focus', apply);
        window.addEventListener('blur', apply);
        document.addEventListener('visibilitychange', apply);
        // Changing the limiter while in the background must not lift the cap.
        game.settings.frameLimit.bind(() => apply());
        apply();
    }

    /** "wosu! — Artist - Title [Diff]" while playing, the menu song otherwise. */
    private updateTitle(): void {
        const { game } = this;
        let title = 'wosu!';
        const sel = game.selection.value;
        const now = game.music.current.value;
        if (this.playing && sel) title = `wosu! — ${sel.set.artist} - ${sel.set.title} [${sel.diff.version}]`;
        else if (now) title = `wosu! — ${now.artist} - ${now.title}`;
        document.title = title;
    }

    /** Dock progress across active downloads, the count as a badge, and a notification when one ends unseen. */
    private trackDownloads(): void {
        const { game, native } = this;
        const sync = () => {
            const active = game.downloads.tasks.filter(t => t.active);
            if (!active.length) {
                native.setDockProgress(-1, '');
                return;
            }
            const progress = active.reduce((a, t) => a + (Number.isFinite(t.progress) ? t.progress : 0), 0) / active.length;
            native.setDockProgress(Math.max(0.01, progress), String(active.length));
        };
        game.downloads.added.add(task => {
            task.changed.add(sync);
            task.result.then(
                () => native.notify('Download finished', `${task.artist} - ${task.title}`),
                () => { if (task.state === 'failed') native.notify('Download failed', `${task.artist} - ${task.title}`); },
            ).finally(sync);
            sync();
        });
    }

    /**
     * Media keys and the macOS Now Playing widget. Chromium only gives a
     * page a media session while a media element plays; the music here is
     * Web Audio, so a silent looping <audio> stands in for it.
     */
    private mediaKeys(): void {
        const session = navigator.mediaSession;
        if (!session) return;
        const { music } = this.game;
        const silent = new Audio(silentWavUrl(10));
        silent.loop = true;
        silent.volume = 0.01;
        session.setActionHandler('play', () => { if (!music.isPlaying) music.togglePause(); });
        session.setActionHandler('pause', () => { if (music.isPlaying) music.togglePause(); });
        session.setActionHandler('nexttrack', () => void music.next());
        session.setActionHandler('previoustrack', () => void music.prev());
        const sync = () => {
            const now = music.current.value;
            // Gameplay owns the keyboard; media keys must not skip the song under a play.
            const active = !!now && !this.playing;
            if (active && music.isPlaying) void silent.play().catch(() => {});
            else silent.pause();
            session.playbackState = !now ? 'none' : music.isPlaying ? 'playing' : 'paused';
            session.metadata = now ? new MediaMetadata({ title: now.title, artist: now.artist, album: 'wosu!' }) : null;
        };
        music.current.bind(sync);
        music.playingState.bind(sync);
        this.game.screens.changed.add(sync);
        sync();
    }
}

/** A PCM WAV of `seconds` of silence (8 kHz mono) as a blob URL. */
function silentWavUrl(seconds: number): string {
    const rate = 8000, samples = rate * seconds;
    const buf = new ArrayBuffer(44 + samples);
    const v = new DataView(buf);
    const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + samples, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
    str(36, 'data'); v.setUint32(40, samples, true);
    new Uint8Array(buf, 44).fill(128); // 8-bit PCM silence is 128
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export let desktopUpdater: DesktopUpdater | null = null;
/** Created up front: the settings overlay is built before the game starts. */
export const lazerLibrary: LazerLibrary | null = native ? new LazerLibrary(native) : null;

export function attachDesktop(game: Game): void {
    if (!native) return;
    // Before anything opens a set or picks the saved skin: lazer's may be among them.
    lazerLibrary?.attach(game);
    new FolderSync(game, native).start();
    desktopUpdater = new DesktopUpdater(game, native);
    void desktopUpdater.checkInBackground();
    void new MacIntegration(game, native).start().catch(e => console.warn('[desktop] integration failed', e));
}

export function openDataFolder(): void {
    void native?.openDataDir();
}

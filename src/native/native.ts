/**
 * The desktop shell's bridge (electron/preload.cjs). Undefined in a
 * browser, where everything falls back to the web behaviour.
 */

/** A store value as it crosses IPC (Blobs cannot). */
export type WireValue =
    | { t: 'blob'; type: string; bytes: Uint8Array }
    | { t: 'v'; v: unknown };

export interface InboxEntry {
    path: string;
    name: string;
    folder: 'songs' | 'skins';
}

export interface UpdateInfo {
    current: string;
    latest?: string;
    available: boolean;
    notes?: string;
    packaged?: boolean;
    error?: string;
}

export interface UpdateProgress {
    phase: 'download' | 'extract' | 'restart';
    received?: number;
    total?: number;
}

export type DisplayMode = 'windowed' | 'fullscreen' | 'borderless';
export type StorageMode = 'wosu' | 'lazer';

/** What the game knows about one .osu of a set it hands to lazer (electron/lazer-write.cjs). */
export interface LazerBeatmapInfo {
    file: string;
    mode: number;
    version: string;
    hp: number; cs: number; od: number; ar: number;
    sliderMultiplier: number;
    sliderTickRate: number;
    length: number;
    bpm: number;
    totalObjectCount: number;
    endTimeObjectCount: number;
    beatDivisor: number;
    onlineId: number;
    md5: string;
    metadata: {
        title: string; titleUnicode: string; artist: string; artistUnicode: string;
        creator: string; creatorId: number; source: string; tags: string;
        previewTime: number; audioFile: string; backgroundFile: string;
    };
}

export interface LazerScoreWrite {
    beatmapMd5: string;
    score: number;
    accuracy: number;
    maxCombo: number;
    combo: number;
    grade: string;
    date: number;
    mods: string[];
    statistics: Record<string, number>;
    player: string;
}

export interface DesktopConfig {
    vsync: boolean;
    displayMode: DisplayMode;
    hidpi: boolean;
    /** Show the osu!lazer library (read in place). */
    lazer: boolean;
    /** Where new beatmaps, skins, scores and collections are saved. */
    storage: StorageMode;
}

export interface WosuNative {
    platform: string;
    /** Started with WOSU_DEBUG=1. */
    debug: boolean;
    db: {
        get(db: string, store: string, key: IDBValidKey): Promise<WireValue | undefined>;
        put(db: string, store: string, schema: { keyPath?: string; autoIncrement?: boolean }, value: WireValue, key?: IDBValidKey): Promise<IDBValidKey>;
        delete(db: string, store: string, key: IDBValidKey): Promise<void>;
        entries(db: string, store: string): Promise<{ key: IDBValidKey; value: WireValue }[]>;
        keys(db: string, store: string): Promise<IDBValidKey[]>;
        clear(db: string, store: string): Promise<void>;
        count(db: string, store: string): Promise<number>;
    };
    inbox: {
        list(): Promise<InboxEntry[]>;
        read(path: string): Promise<Uint8Array>;
        done(path: string): Promise<void>;
        onChanged(fn: () => void): () => void;
    };
    update: {
        check(): Promise<UpdateInfo>;
        install(): Promise<void>;
        onProgress(fn: (p: UpdateProgress) => void): () => void;
    };
    openDataDir(): Promise<string>;
    config: {
        /** Read synchronously when the page loaded. */
        initial: DesktopConfig;
        set(patch: Partial<DesktopConfig>): Promise<DesktopConfig>;
        onChanged(fn: (c: DesktopConfig) => void): () => void;
    };
    /** Restart the whole app (Chromium switches such as vsync apply only at launch). */
    relaunch(): Promise<void>;
    /** Read-only osu!lazer library (electron/lazer.cjs). */
    lazer: {
        library(): Promise<LazerLibraryData>;
        read(hash: string): Promise<Uint8Array>;
        /** Writes below fail with "LAZER_RUNNING: …" while lazer is open. */
        running(): Promise<boolean>;
        importBeatmapSet(osz: Uint8Array, info: { onlineId: number; beatmaps: LazerBeatmapInfo[] }): Promise<{ id: string; existed: boolean }>;
        importSkin(osk: Uint8Array, info: { name: string; author: string }): Promise<{ id: string; existed: boolean }>;
        addScore(osr: Uint8Array, score: LazerScoreWrite): Promise<{ id: string }>;
        createCollection(name: string, md5s: string[]): Promise<{ id: string }>;
        updateCollection(id: string, patch: { name?: string; md5s?: string[] }): Promise<{ id: string }>;
        deleteCollection(id: string): Promise<{ id: string }>;
        delete(type: 'BeatmapSet' | 'Skin' | 'Score', id: string): Promise<{ id: string }>;
    };
    /** Menu bar items handled by the game. */
    onMenu(fn: (action: MenuAction) => void): () => void;
    /** A screenshot/replay/export was written under ~/.wosu. */
    onFileSaved(fn: (f: { path: string; folder: string }) => void): () => void;
    /** A file opened with the app that is not imported (an .osr replay). */
    onOpenFile(fn: (f: { name: string; bytes: Uint8Array }) => void): () => void;
    showInFolder(path: string): Promise<void>;
    /** In gameplay: keep the display awake. */
    setPlaying(playing: boolean): void;
    /** Dock progress bar (0..1, negative hides) and badge text. */
    setDockProgress(progress: number, badge?: string): void;
    /** System notification, shown only while the window is not focused. */
    notify(title: string, body?: string): void;
}

export interface LazerFile {
    name: string;
    hash: string;
    size: number;
}

export interface LazerLibraryData {
    available: boolean;
    dir: string;
    sets: {
        id: string;
        onlineId: number;
        /** Changes whenever the set's files change. */
        hash: string;
        files: LazerFile[];
        /** osu!standard difficulties: their .osu file hash and lazer's star rating. */
        beatmaps: { hash: string; md5: string; onlineId: number; stars: number }[];
    }[];
    skins: { id: string; name: string; creator: string; hash: string; files: LazerFile[] }[];
    /** Collections by the MD5 of each member's .osu file. */
    collections: { id: string; name: string; md5s: string[] }[];
    /** Local osu!standard scores that have a replay (.osr in lazer's file store). */
    scores: LazerScoreData[];
    /** The player's lazer username (from its newest local score), if any. */
    username: string | null;
}

export interface LazerScoreData {
    id: string;
    md5: string;
    total: number;
    accuracy: number;
    maxCombo: number;
    /** lazer's ScoreRank: -1 F, 0 D, 1 C, 2 B, 3 A, 4 S, 5 SH, 6 X, 7 XH. */
    rank: number;
    date: number;
    /** JSON: [{ acronym, settings? }]. */
    mods: string;
    /** JSON: { great, ok, meh, miss, … }. */
    statistics: string;
    /** JSON: { username, … }. */
    user: string;
    replayHash: string;
}

export type MenuAction = 'settings' | 'checkUpdates' | 'import' | 'openReplay' | 'reloadLazer' | 'fullscreen' | 'debugAudio' | 'debugInput';

export const native: WosuNative | undefined = (globalThis as { wosuNative?: WosuNative }).wosuNative;

/** Error text without Electron's "Error invoking remote method …: Error:" prefix. */
export function nativeError(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    return msg.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
}

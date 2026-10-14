/**
 * The osu!lazer library, read in place (desktop app): its beatmap sets
 * and skins show up in wosu! with their files read from lazer's store on
 * demand. Only metadata (difficulty summaries, small thumbnails) is kept
 * under ~/.wosu; deleting here hides an item without touching lazer.
 */
import type { Game } from '../app/Game';
import { OszArchive } from '../beatmap/archive';
import type { ExternalSetSource } from '../beatmap/Library';
import { Bindable } from '../core/Bindable';
import type { ExternalSkinSource, StoredSkin } from '../storage/SkinStore';
import { collections } from '../storage/Collections';
import { beatmapKeyOf, type ExternalScoreSource, type Grade, type ScoreRecord } from '../storage/ScoreStore';
import { isModAcronym } from '../gameplay/mods';
import { md5Hex } from '../core/md5';
import { parseOsu } from '../beatmap/parser';
import { summarizeDifficulty } from '../beatmap/summary';
import type { ImportOptions, LibrarySet } from '../beatmap/Library';
import type { DifficultySummary } from '../beatmap/types';
import { readSkinArchive } from '../skin/SkinImport';
import type { LazerBeatmapInfo, LazerScoreWrite } from './native';
import { decodeReplay } from '../gameplay/replay/Replay';
import { encodeOsr } from '../gameplay/replay/osr';
import { nativeError, type LazerFile, type LazerLibraryData, type LazerScoreData, type WosuNative } from './native';

/** lazer's ScoreRank values. */
const LAZER_RANKS: Record<number, Grade> = { [-1]: 'F', 0: 'D', 1: 'C', 2: 'B', 3: 'A', 4: 'S', 5: 'SH', 6: 'X', 7: 'XH' };

function parseJson(s: string): unknown {
    try {
        return JSON.parse(s);
    } catch {
        return null;
    }
}

const SET_PREFIX = 'lazer-';
const SKIN_PREFIX = 'lazer-skin-';
const HIDDEN_KEY = 'lazer-hidden';
const STAMPS_KEY = 'lazer-stamps';
export const LAZER_OPEN_MESSAGE = 'osu!lazer is open: close it to save to its library.';

export class LazerLibrary implements ExternalSetSource, ExternalSkinSource, ExternalScoreSource {
    readonly enabled: Bindable<boolean>;
    /** Shown in settings: what was found where. */
    readonly status = new Bindable('Not loaded yet.');
    private files = new Map<string, LazerFile[]>();
    private hidden = new Set<string>();
    /** .osu MD5 → where that difficulty is (lazer's own MD5s, no hashing needed). */
    private md5Index = new Map<string, { key: string; file: string }>();
    /** "key|file" → .osu MD5, from lazer's database (summaries made before MD5s were recorded lack them). */
    private md5ByItem = new Map<string, string>();
    /** Per lazer collection: members wosu! can't show (other rulesets, outdated maps), kept on every write. */
    private unmapped = new Map<string, string[]>();
    private running: Promise<void> | null = null;
    private gameRef: Game | null = null;

    /** "Store in osu!lazer": new beatmaps, skins, scores and collections are written into its library. */
    readonly storeInLazer: Bindable<boolean>;

    constructor(private readonly native: WosuNative) {
        this.storeInLazer = new Bindable(native.config.initial.storage === 'lazer');
        this.storeInLazer.bind(v => {
            void native.config.set({ storage: v ? 'lazer' : 'wosu' });
            // Storing in lazer means showing it too.
            if (v && !this.enabled.value) this.enabled.value = true;
            this.applyWriters();
        });
        this.enabled = new Bindable(native.config.initial.lazer || native.config.initial.storage === 'lazer');
        this.enabled.bind(v => {
            void native.config.set({ lazer: v });
            // Not showing lazer means not storing there either.
            if (!v && this.storeInLazer.value) this.storeInLazer.value = false;
            this.applyWriters();
            if (this.gameRef) void this.sync();
        });
    }

    private get game(): Game {
        if (!this.gameRef) throw new Error('osu!lazer library used before the game started');
        return this.gameRef;
    }

    /** Hook into the game's library and skins, and list lazer's content. */
    attach(game: Game): void {
        this.gameRef = game;
        game.library.external = this;
        this.applyWriters();
        // The saved skin may be one of lazer's: hold its lookup until they are listed.
        this.firstSync = this.sync();
        game.skins.store.deferUntil(this.firstSync);
        // After the first sync: moving scores needs lazer's MD5s.
        this.watchForAutoMove();
    }

    /** Resolves once lazer's library was listed at startup. */
    firstSync: Promise<void> = Promise.resolve();

    owns(key: string): boolean {
        return key.startsWith(SET_PREFIX);
    }

    async open(key: string): Promise<OszArchive> {
        const files = this.files.get(key);
        if (!files) throw new Error('This beatmap is no longer in osu!lazer');
        const byName = new Map(files.map(f => [f.name, f.hash]));
        return OszArchive.fromFiles(files, name => {
            const hash = byName.get(name);
            if (!hash) return Promise.reject(new Error(`File not found: ${name}`));
            return this.native.lazer.read(hash);
        });
    }

    findMd5(md5: string): { key: string; file: string } | null {
        return this.md5Index.get(md5.toLowerCase()) ?? null;
    }

    async osr(record: ScoreRecord): Promise<Uint8Array | null> {
        return record.sourceRef ? this.native.lazer.read(record.sourceRef) : null;
    }

    async hide(key: string): Promise<void> {
        if (this.writes) {
            // Stored in lazer: deleting here deletes there (its soft delete).
            const id = key.startsWith(SKIN_PREFIX) ? key.slice(SKIN_PREFIX.length) : key.slice(SET_PREFIX.length);
            try {
                await this.deleteInLazer(key.startsWith(SKIN_PREFIX) ? 'Skin' : 'BeatmapSet', id);
            } catch (e) {
                this.game.notifications.error(e instanceof Error ? e.message : String(e));
                throw e;
            }
            this.files.delete(key);
            return;
        }
        this.hidden.add(key);
        this.files.delete(key);
        await this.saveKv(HIDDEN_KEY, [...this.hidden]);
    }

    /** Bring back everything deleted in wosu!. */
    async unhideAll(): Promise<void> {
        this.hidden.clear();
        await this.saveKv(HIDDEN_KEY, []);
        await this.sync();
    }

    /** Re-read lazer's database and bring the library in line (incremental). */
    sync(): Promise<void> {
        if (!this.gameRef) return Promise.resolve();
        this.running ??= this.run().finally(() => { this.running = null; });
        return this.running;
    }

    private async run(): Promise<void> {
        const { library, skins } = this.game;
        await library.init();
        this.hidden = new Set((await this.loadKv<string[]>(HIDDEN_KEY)) ?? []);

        let data: LazerLibraryData | null = null;
        if (this.enabled.value) {
            try {
                data = await this.native.lazer.library();
            } catch (e) {
                console.warn('[lazer] reading the database failed', e);
                this.status.value = `Couldn't read osu!lazer's database: ${nativeError(e)}`;
            }
        }
        const sets = data?.available ? data.sets : [];

        // Skins: listed fresh every time (nothing to precompute).
        this.files = new Map();
        const skinRows: StoredSkin[] = [];
        for (const s of data?.available ? data.skins : []) {
            const id = SKIN_PREFIX + s.id;
            this.files.set(id, s.files);
            if (this.hidden.has(id)) continue;
            skinRows.push({
                id,
                name: `${s.name} (lazer)`,
                author: s.creator || 'unknown',
                filename: '',
                addedAt: 0,
                sizeBytes: s.files.reduce((a, f) => a + f.size, 0),
            });
        }
        skins.store.setExternal(this, skinRows);

        // Sets no longer in lazer (or the library switched off).
        const present = new Set(sets.map(s => SET_PREFIX + s.id));
        const gone = library.sets.filter(s => this.owns(s.key) && (!present.has(s.key) || this.hidden.has(s.key)));
        for (const s of gone) await library.forget(s.key, true);
        if (gone.length) library.refresh();

        if (!data?.available) {
            if (this.enabled.value && data) this.status.value = `osu!lazer was not found (looked in ${data.dir}).`;
            else if (!this.enabled.value) this.status.value = 'Off.';
            return;
        }

        this.md5Index = new Map();
        this.md5ByItem = new Map();
        for (const s of sets) {
            const byHash = new Map(s.files.map(f => [f.hash, f.name]));
            for (const b of s.beatmaps) {
                const file = byHash.get(b.hash);
                if (!file || !b.md5) continue;
                const md5 = b.md5.toLowerCase();
                this.md5Index.set(md5, { key: SET_PREFIX + s.id, file });
                this.md5ByItem.set(`${SET_PREFIX + s.id}|${file}`, md5);
            }
        }

        const stamps = (await this.loadKv<Record<string, string>>(STAMPS_KEY)) ?? {};
        const todo: LazerLibraryData['sets'] = [];
        for (const s of sets) {
            const key = SET_PREFIX + s.id;
            this.files.set(key, s.files);
            if (this.hidden.has(key)) continue;
            if (!library.get(key) || stamps[key] !== s.hash) todo.push(s);
        }

        const note = todo.length > 10 ? this.game.notifications.progress(`Reading ${todo.length} beatmap sets from osu!lazer…`) : null;
        let done = 0, failed = 0;
        const one = async (s: LazerLibraryData['sets'][number]) => {
            const key = SET_PREFIX + s.id;
            const byHash = new Map(s.files.map(f => [f.hash, f.name]));
            const osuFiles: string[] = [];
            const stars = new Map<string, number>();
            const md5s = new Map<string, string>();
            for (const b of s.beatmaps) {
                const name = byHash.get(b.hash);
                if (!name) continue;
                osuFiles.push(name);
                stars.set(name, b.stars);
                if (b.md5) md5s.set(name, b.md5.toLowerCase());
            }
            try {
                await library.importArchive(await this.open(key), null, {
                    key,
                    sizeBytes: s.files.reduce((a, f) => a + f.size, 0),
                    osuFiles,
                    stars,
                    md5s,
                    onlineSetId: s.onlineId > 0 ? s.onlineId : undefined,
                    quiet: true,
                });
                stamps[key] = s.hash;
            } catch (e) {
                failed++;
                console.warn(`[lazer] set ${s.id} skipped`, e);
            }
            done++;
            if (note) note.progress.value = done / todo.length;
            if (done % 50 === 0) {
                library.refresh();
                await this.saveKv(STAMPS_KEY, stamps);
            }
        };
        // A few at a time: most of the work is waiting for file reads.
        const queue = [...todo];
        await Promise.all(Array.from({ length: 4 }, async () => {
            for (let s = queue.shift(); s; s = queue.shift()) await one(s);
        }));
        if (todo.length) {
            library.refresh();
            await this.saveKv(STAMPS_KEY, stamps);
        }
        note?.complete(`Added ${done - failed} beatmap sets from osu!lazer.`);
        this.syncScores(data.scores);
        // Still the default name: take the player's lazer username (replays, scores, toolbar).
        if (data.username && this.game.settings.playerName.value === 'Guest') this.game.settings.playerName.value = data.username;
        void this.syncCollections(data.collections).catch(e => console.warn('[lazer] collections failed', e));
        const shown = sets.filter(s => !this.hidden.has(SET_PREFIX + s.id)).length;
        this.status.value = `${shown} beatmap sets and ${skinRows.length} skins from ${data.dir}` +
            (this.hidden.size ? ` (${this.hidden.size} hidden in wosu!)` : '') + '.';
    }

    /** lazer's collections, mirrored into wosu!'s (see CollectionStore.syncExternal). */
    private async syncCollections(cols: LazerLibraryData['collections']): Promise<void> {
        this.unmapped = new Map(cols.map(c => [c.id, c.md5s.filter(m => !this.md5Index.has(m.toLowerCase()))]));
        const mapped = cols.map(c => ({
            id: c.id,
            name: c.name,
            items: c.md5s
                .map(m => this.md5Index.get(m.toLowerCase()))
                .filter((x): x is { key: string; file: string } => !!x && !this.hidden.has(x.key))
                .map(x => `${x.key}|${x.file}`),
        }));
        await collections().syncExternal(mapped);
    }

    /** lazer's local scores with replays, listed on leaderboards (read-only). */
    private syncScores(scores: readonly LazerScoreData[]): void {
        const { library } = this.game;
        const records: ScoreRecord[] = [];
        for (const s of scores) {
            const at = this.md5Index.get(s.md5.toLowerCase());
            const set = at && !this.hidden.has(at.key) ? library.get(at.key) : undefined;
            const diff = set && at ? [...set.difficulties, ...(set.hidden ?? [])].find(d => d.file === at.file) : undefined;
            if (!set || !diff) continue;
            const stats = (parseJson(s.statistics) ?? {}) as Record<string, number>;
            const user = (parseJson(s.user) ?? {}) as { username?: string; Username?: string };
            const mods = ((parseJson(s.mods) ?? []) as { acronym?: string }[])
                .map(m => m?.acronym)
                .filter(isModAcronym);
            const grade = LAZER_RANKS[s.rank] ?? 'D';
            records.push({
                beatmapKey: beatmapKeyOf({ beatmapId: diff.beatmapId, title: set.title, version: diff.version, setId: set.onlineSetId ?? 0 }),
                beatmapId: diff.beatmapId,
                setId: set.onlineSetId ?? 0,
                title: set.title,
                artist: set.artist,
                version: diff.version,
                creator: set.creator,
                mods,
                score: s.total,
                accuracy: s.accuracy,
                maxCombo: s.maxCombo,
                count300: stats.great ?? 0,
                count100: stats.ok ?? 0,
                count50: stats.meh ?? 0,
                countMiss: stats.miss ?? 0,
                grade,
                passed: grade !== 'F',
                date: s.date,
                player: user.username ?? user.Username ?? 'osu!lazer',
                mechanics: 'lazer',
                hasReplay: true,
                source: 'lazer',
                sourceRef: s.replayHash,
                sourceId: s.id,
            });
        }
        this.game.scores.setExternal(this, records);
    }

    // ------------------------------------------------------------------
    // Writing into lazer ("store in osu!lazer")
    // ------------------------------------------------------------------

    /**
     * "Store in osu!lazer" moves wosu!'s own items over by itself: after
     * startup, when the mode is turned on, and as soon as lazer is closed
     * (a score kept here while lazer was open goes over then).
     */
    private watchForAutoMove(): void {
        let wasRunning = false;
        const check = async () => {
            if (!this.writes) return;
            const running = await this.native.lazer.running().catch(() => true);
            if (!running && (wasRunning || this.autoMoveDue)) {
                this.autoMoveDue = false;
                await this.migrateLocal(true).catch(e => console.warn('[lazer] auto move failed', e));
            }
            wasRunning = running;
        };
        void this.firstSync.then(() => check());
        setInterval(() => void check(), 15_000);
        this.storeInLazer.bind(v => {
            if (v) {
                this.autoMoveDue = true;
                void check();
            }
        });
    }

    /** A move should run at the next chance (startup, mode just turned on, a score kept locally). */
    private autoMoveDue = true;

    /** Point the game's stores at lazer (or back at ~/.wosu) for new data. */
    private applyWriters(): void {
        const game = this.gameRef;
        if (!game) return;
        const on = this.writes;
        game.library.writer = on ? { importOsz: (d, o) => this.importOsz(d, o) } : null;
        game.skins.writer = on ? { importSkin: (d, f) => this.importSkin(d, f) } : null;
        game.scores.writer = on ? { add: (r, replay) => this.addScoreRecord(r, replay) } : null;
        game.scores.externalDeletable = on;
        collections().writer = on ? {
            create: async (name, items) => {
                const r = await this.createCollection(name, items);
                void this.sync();
                return r;
            },
            update: (id, patch) => this.updateCollection(id, patch),
            remove: id => this.deleteCollection(id),
            failed: e => {
                game.notifications.error(e instanceof Error ? e.message : String(e));
                void this.sync();
            },
        } : null;
    }

    async deleteScore(record: ScoreRecord): Promise<void> {
        if (!record.sourceId) throw new Error('This score cannot be deleted');
        await this.deleteInLazer('Score', record.sourceId);
    }

    /**
     * A finished play: written to lazer (score + .osr) when its beatmap is
     * there and lazer is closed. Resolves false to keep it in wosu! instead.
     */
    private async addScoreRecord(record: ScoreRecord, replay?: Uint8Array): Promise<boolean> {
        if (!replay) return false;
        const { library } = this.game;
        let diff: DifficultySummary | undefined;
        let md5: string | undefined;
        for (const set of library.sets) {
            if (!this.owns(set.key)) continue;
            diff = [...set.difficulties, ...(set.hidden ?? [])].find(d => beatmapKeyOf({ beatmapId: d.beatmapId, title: set.title, version: d.version, setId: set.onlineSetId ?? 0 }) === record.beatmapKey);
            if (diff) {
                md5 = diff.md5 ?? this.md5ByItem.get(`${set.key}|${diff.file}`);
                break;
            }
        }
        if (!diff || !md5) return false;
        if (await this.native.lazer.running()) {
            this.game.notifications.warning('osu!lazer is open: this score is kept in wosu! and moves over once lazer is closed.');
            this.autoMoveDue = true;
            return false;
        }
        const osr = encodeOsr({
            beatmapMd5: md5,
            player: record.player || 'Guest',
            count300: record.count300,
            count100: record.count100,
            count50: record.count50,
            countMiss: record.countMiss,
            score: record.score,
            maxCombo: record.maxCombo,
            perfect: record.countMiss === 0 && record.maxCombo >= diff.maxCombo,
            mods: record.mods,
            date: record.date,
            events: decodeReplay(replay),
        });
        await this.addScore(osr, {
            beatmapMd5: md5,
            score: record.score,
            accuracy: record.accuracy,
            maxCombo: record.maxCombo,
            combo: record.maxCombo,
            grade: record.grade,
            date: record.date,
            mods: [...record.mods],
            statistics: { great: record.count300, ok: record.count100, meh: record.count50, miss: record.countMiss },
            player: record.player,
        });
        return true;
    }

    /**
     * Move what wosu! stores itself (~/.wosu: beatmaps, skins, scores with
     * replays) into lazer, deleting each local copy once lazer has it.
     */
    async migrateLocal(auto = false): Promise<void> {
        if (this.migrating) return;
        this.migrating = true;
        try {
            await this.migrate(auto);
        } finally {
            this.migrating = false;
        }
    }

    private migrating = false;
    /** Items an automatic move already failed on this session (not retried until restart). */
    private readonly autoFailed = new Set<string>();

    private async migrate(auto: boolean): Promise<void> {
        const { library, skins, scores, notifications } = this.game;
        if (auto) {
            if (!this.writes || await this.native.lazer.running()) return;
        } else {
            try {
                await this.ensureClosed();
            } catch (e) {
                notifications.error(e instanceof Error ? e.message : String(e));
                return;
            }
        }
        const skip = (k: string) => auto && this.autoFailed.has(k);
        const sets = library.sets.filter(s => !this.owns(s.key) && !skip(s.key));
        const skinRows = skins.store.list.filter(s => !s.id.startsWith('lazer-') && !skip(s.id));
        const local = (await scores.all()).filter(r => r.id !== undefined && r.hasReplay && !skip(`score:${r.id}`));
        const total = sets.length + skinRows.length + local.length;
        if (!total) {
            if (!auto) notifications.info('Nothing to move: everything is already in osu!lazer.');
            return;
        }
        const failedKeys: string[] = [];
        const n = notifications.progress(`Moving ${total} item${total > 1 ? 's' : ''} into osu!lazer…`);
        let done = 0, moved = 0;
        const failures: string[] = [];
        const step = () => { n.progress.value = ++done / total; };
        for (const set of sets) {
            try {
                const blob = await library.blobOf(set.key);
                if (!blob) throw new Error('its files are missing');
                await this.importOsz(blob, { onlineSetId: set.onlineSetId ?? undefined });
                await library.delete(set.key);
                moved++;
            } catch (e) {
                failedKeys.push(set.key);
                failures.push(`${set.artist} - ${set.title}: ${e instanceof Error ? e.message : String(e)}`);
            }
            step();
        }
        for (const row of skinRows) {
            try {
                const blob = await skins.store.blob(row.id);
                if (!blob) throw new Error('its files are missing');
                const moved_ = await this.importSkin(blob, row.filename || `${row.name}.osk`);
                if (this.game.settings.skin.value === row.id) this.game.settings.skin.value = moved_.id;
                await skins.store.delete(row.id);
                moved++;
            } catch (e) {
                failedKeys.push(row.id);
                failures.push(`${row.name}: ${e instanceof Error ? e.message : String(e)}`);
            }
            step();
        }
        for (const r of local) {
            try {
                const replay = await scores.replay(r.id!);
                if (replay && await this.addScoreRecord(r, replay)) {
                    await scores.delete(r.id!);
                    moved++;
                } else {
                    failedKeys.push(`score:${r.id}`);
                    failures.push(`${r.title} [${r.version}] score: its beatmap is not in osu!lazer`);
                }
            } catch (e) {
                failedKeys.push(`score:${r.id}`);
                failures.push(`${r.title} [${r.version}] score: ${e instanceof Error ? e.message : String(e)}`);
            }
            step();
        }
        if (auto) for (const k of failedKeys) this.autoFailed.add(k);
        if (failures.length) n.fail(`Moved ${moved} of ${total} into osu!lazer.`);
        else n.complete(`Moved ${moved} item${moved > 1 ? 's' : ''} into osu!lazer.`);
        // Automatic runs keep it to the summary; the full list is in the log.
        for (const f of failures) console.warn('[lazer] move failed:', f);
        if (!auto) for (const f of failures.slice(0, 5)) notifications.error(f);
        await this.sync();
    }

    /** True when writes go to lazer (and it must be closed for them). */
    get writes(): boolean {
        return this.storeInLazer.value && this.enabled.value;
    }

    /** Throws the user-facing "close lazer" error when it is open. */
    async ensureClosed(): Promise<void> {
        if (await this.native.lazer.running()) throw new Error(LAZER_OPEN_MESSAGE);
    }

    /** Import an .osz into lazer's library; returns the set as wosu! lists it. */
    async importOsz(data: Blob, opts: ImportOptions = {}): Promise<LibrarySet> {
        const bytes = new Uint8Array(await data.arrayBuffer());
        let archive: OszArchive;
        try {
            archive = await OszArchive.open(bytes);
        } catch {
            throw new Error('Not a valid .osz archive');
        }
        const beatmaps: LazerBeatmapInfo[] = [];
        let onlineId = opts.onlineSetId ?? 0;
        for (const file of archive.osuFiles()) {
            try {
                const raw = await archive.readBytes(file);
                const text = new TextDecoder('utf-8').decode(raw);
                const data = parseOsu(text);
                if (data.metadata.beatmapSetId > 0) onlineId = data.metadata.beatmapSetId;
                const s = summarizeDifficulty(data, file);
                const objects = data.hitObjects;
                const endTime = objects.filter(h => h.kind !== 'circle').length;
                beatmaps.push({
                    file,
                    mode: data.general.mode,
                    version: data.metadata.version,
                    hp: data.difficulty.hpDrainRate,
                    cs: data.difficulty.circleSize,
                    od: data.difficulty.overallDifficulty,
                    ar: data.difficulty.approachRate,
                    sliderMultiplier: data.difficulty.sliderMultiplier,
                    sliderTickRate: data.difficulty.sliderTickRate,
                    length: s.length,
                    bpm: s.bpm,
                    totalObjectCount: objects.length,
                    endTimeObjectCount: endTime,
                    beatDivisor: Number(/^\s*BeatDivisor\s*:\s*(\d+)/m.exec(text)?.[1] ?? 4) || 4,
                    onlineId: data.metadata.beatmapId > 0 ? data.metadata.beatmapId : -1,
                    md5: md5Hex(raw),
                    metadata: {
                        title: data.metadata.title,
                        titleUnicode: data.metadata.titleUnicode,
                        artist: data.metadata.artist,
                        artistUnicode: data.metadata.artistUnicode,
                        creator: data.metadata.creator,
                        creatorId: -1,
                        source: data.metadata.source,
                        tags: data.metadata.tags,
                        previewTime: data.general.previewTime,
                        audioFile: data.general.audioFilename,
                        backgroundFile: data.events.backgroundFile ?? '',
                    },
                });
            } catch (e) {
                console.warn(`[lazer] skipping unreadable "${file}"`, e);
            }
        }
        if (!beatmaps.length) throw new Error('No .osu files in archive');
        if (!beatmaps.some(b => b.mode === 0)) throw new Error('No osu!standard difficulties');
        const res = await this.call(() => this.native.lazer.importBeatmapSet(bytes, { onlineId, beatmaps }));
        await this.sync();
        const set = this.game.library.get(SET_PREFIX + res.id);
        if (!set) throw new Error('osu!lazer saved the beatmap, but it could not be listed');
        return set;
    }

    /** Import an .osk into lazer's skins; returns its wosu! id. */
    async importSkin(data: Blob, filename: string): Promise<StoredSkin> {
        const bytes = new Uint8Array(await data.arrayBuffer());
        const { meta } = await readSkinArchive(bytes, filename);
        const res = await this.call(() => this.native.lazer.importSkin(bytes, { name: meta.name, author: meta.author }));
        await this.sync();
        const row = this.game.skins.store.get(SKIN_PREFIX + res.id);
        if (!row) throw new Error('osu!lazer saved the skin, but it could not be listed');
        return row;
    }

    /** A finished play as a lazer local score (with its .osr). */
    async addScore(osr: Uint8Array, score: LazerScoreWrite): Promise<void> {
        await this.call(() => this.native.lazer.addScore(osr, score));
        await this.sync();
    }

    /** The .osu MD5s behind collection member keys ("set|file"). */
    md5sOf(items: readonly string[]): string[] {
        const out: string[] = [];
        for (const k of items) {
            const known = this.md5ByItem.get(k);
            if (known) {
                out.push(known);
                continue;
            }
            const [key, file] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
            const set = this.game.library.get(key);
            const d = set ? [...set.difficulties, ...(set.hidden ?? [])].find(x => x.file === file) : undefined;
            if (d?.md5) out.push(d.md5);
        }
        return out;
    }

    createCollection(name: string, items: readonly string[]): Promise<{ id: string }> {
        return this.call(() => this.native.lazer.createCollection(name, this.md5sOf(items)));
    }

    updateCollection(id: string, patch: { name?: string; items?: readonly string[] }): Promise<{ id: string }> {
        return this.call(() => this.native.lazer.updateCollection(id, {
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.items ? { md5s: [...this.md5sOf(patch.items), ...(this.unmapped.get(id) ?? [])] } : {}),
        }));
    }

    deleteCollection(id: string): Promise<{ id: string }> {
        return this.call(() => this.native.lazer.deleteCollection(id));
    }

    /** Delete in lazer (its soft delete; lazer purges the files on its next start). */
    async deleteInLazer(type: 'BeatmapSet' | 'Skin' | 'Score', id: string): Promise<void> {
        await this.call(() => this.native.lazer.delete(type, id));
    }

    /** IPC errors carry "LAZER_RUNNING:" for the one the player can fix. */
    private async call<T>(fn: () => Promise<T>): Promise<T> {
        try {
            return await fn();
        } catch (e) {
            const msg = nativeError(e);
            throw new Error(msg.startsWith('LAZER_RUNNING') ? LAZER_OPEN_MESSAGE : msg);
        }
    }

    private async loadKv<T>(key: string): Promise<T | undefined> {
        const w = await this.native.db.get('webosu', 'kv', key);
        return w?.t === 'v' ? (w.v as T) : undefined;
    }

    private async saveKv(key: string, value: unknown): Promise<void> {
        await this.native.db.put('webosu', 'kv', {}, { t: 'v', v: value }, key);
    }
}

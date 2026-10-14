/**
 * Local score records (the offline leaderboard and play history).
 *
 * All records are mirrored in memory after `init()`: even thousands of
 * scores are tiny, and song select queries them on every selection.
 */
import { Signal } from '../core/Signal';
import { modSettingsOf, parseLegacyModString, sortedMods, withSettings, type ModAcronym, type ModSettingsMap } from '../gameplay/mods';
import type { GameplayMechanics } from '../gameplay/scoring/mechanics';
import { openAppDatabase, type AppDatabase } from './idb';
import { migrateOnce, readLegacyData, type LegacyHistoryEntry, type LegacySource } from './legacy';

/** osu! grades; X = SS, H suffix = silver (Hidden/Flashlight). */
export type Grade = 'XH' | 'X' | 'SH' | 'S' | 'A' | 'B' | 'C' | 'D' | 'F';

export const GRADES: readonly Grade[] = ['XH', 'X', 'SH', 'S', 'A', 'B', 'C', 'D', 'F'];

export interface ScoreRecord {
    id?: number;
    beatmapKey: string;
    beatmapId: number;
    setId: number;
    title: string;
    artist: string;
    version: string;
    creator: string;
    mods: ModAcronym[];
    /** Customised mod settings the score was set with (lazer stores them with the mods). */
    modSettings?: ModSettingsMap;
    score: number;
    accuracy: number; // 0..1
    maxCombo: number;
    count300: number;
    count100: number;
    count50: number;
    countMiss: number;
    grade: Grade;
    passed: boolean;
    date: number;
    player: string;
    /** Imported from the old site's history (no hit counts). */
    legacy?: boolean;
    /** Gameplay mechanics the score was set with (absent: set before they were recorded). */
    mechanics?: GameplayMechanics;
    /** A replay is stored for this score (see `replay`). */
    hasReplay?: boolean;
    /**
     * Listed from another client (osu!lazer's realm, desktop app): not
     * stored here, cannot be deleted here; its replay is an .osr there.
     */
    source?: 'lazer';
    /** The source's handle for the replay (lazer: the .osr file's hash). */
    sourceRef?: string;
    /** The source's id for the score itself (lazer: its Score ID). */
    sourceId?: string;
}

/** Scores that live in another client (see `ScoreStore.setExternal`). */
export interface ExternalScoreSource {
    /** The replay as the source keeps it: an osu! .osr file. */
    osr(record: ScoreRecord): Promise<Uint8Array | null>;
    /** Present when the source lets scores be deleted from here. */
    deleteScore?(record: ScoreRecord): Promise<void>;
}

/**
 * Stable identity for a difficulty: the online beatmap id when known,
 * otherwise set + title + version (local imports of unsubmitted maps).
 */
export function beatmapKeyOf(b: { beatmapId: number; title: string; version: string; setId: number }): string {
    if (b.beatmapId > 0) return `bid:${b.beatmapId}`;
    return `t:${b.setId > 0 ? b.setId : 0}|${b.title}|${b.version}`.toLowerCase();
}

function num(v: unknown, fallback = 0): number {
    if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
    if (typeof v === 'string') {
        const n = parseFloat(v.replace(/[,%\s]/g, ''));
        return Number.isFinite(n) ? n : fallback;
    }
    return fallback;
}

function legacyGrade(g: unknown): Grade {
    const s = String(g ?? '').trim().toUpperCase();
    if (s === 'SS') return 'X';
    if (s === 'SSH') return 'XH';
    return (GRADES as readonly string[]).includes(s) ? (s as Grade) : 'D';
}

/** Old site's mod strings used "RL" for Relax. */
function legacyMods(s: unknown): ModAcronym[] {
    const str = String(s ?? '').replace(/\bRL\b/g, 'RX');
    return sortedMods(parseLegacyModString(str));
}

/** Convert one old `playhistory1000` row; null when unusable. */
export function migrateHistoryEntry(h: LegacyHistoryEntry): ScoreRecord | null {
    if (!h || typeof h !== 'object') return null;
    const title = String(h.title ?? '').trim();
    const version = String(h.version ?? '').trim();
    if (!title && !h.bid) return null;
    const beatmapId = Math.max(0, Math.trunc(num(h.bid)));
    const setId = Math.max(0, Math.trunc(num(h.sid)));
    const grade = legacyGrade(h.grade);
    let acc = num(h.acc, 0);
    // "98.50%" strings and 0..100 numbers both mean percent.
    if (typeof h.acc === 'string' || acc > 1) acc /= 100;
    return {
        beatmapKey: beatmapKeyOf({ beatmapId, title, version, setId }),
        beatmapId,
        setId,
        title,
        artist: '',
        version,
        creator: '',
        mods: legacyMods(h.mods),
        score: Math.max(0, Math.round(num(h.score))),
        accuracy: Math.min(1, Math.max(0, acc)),
        maxCombo: Math.max(0, Math.round(num(h.combo))),
        count300: 0,
        count100: 0,
        count50: 0,
        countMiss: 0,
        grade,
        passed: grade !== 'F',
        date: num(h.time, 0) || 0,
        player: 'Guest',
        legacy: true,
    };
}

export interface ScoreStoreOptions {
    legacy?: LegacySource;
}

export class ScoreStore {
    readonly changed = new Signal<[record: ScoreRecord]>();
    /** Scores were deleted (one, or all). */
    readonly removed = new Signal<[]>();
    private records: ScoreRecord[] = [];
    private db: AppDatabase | null = null;
    private ready: Promise<void> | null = null;
    private readonly legacySource: LegacySource;

    constructor(private readonly dbSource: AppDatabase | Promise<AppDatabase> = openAppDatabase(), options: ScoreStoreOptions = {}) {
        this.legacySource = options.legacy ?? readLegacyData;
    }

    init(): Promise<void> {
        this.ready ??= this.load();
        return this.ready;
    }

    private async load(): Promise<void> {
        const db = await this.dbSource;
        this.db = db;
        try {
            this.records = ((await db.scores.getAll()) as ScoreRecord[]).filter(r => r && typeof r === 'object');
        } catch (e) {
            console.warn('[scores] load failed', e);
            this.records = [];
        }
        await migrateOnce(db.kv, 'scores', async (data) => {
            for (const h of data.history) {
                const rec = migrateHistoryEntry(h);
                if (!rec) continue;
                // Skip duplicates if a partial earlier run already wrote it.
                if (this.records.some(r => r.legacy && r.date === rec.date && r.beatmapKey === rec.beatmapKey)) continue;
                rec.id = await db.scores.put(rec);
                this.records.push(rec);
            }
        }, this.legacySource);
    }

    /**
     * When set, new scores go there first (desktop: "store in osu!lazer");
     * it resolves false to have this store keep the score instead.
     */
    writer: { add(record: ScoreRecord, replay?: Uint8Array): Promise<boolean> } | null = null;

    /** Persist a new record, with its encoded replay if any; resolves with it (id assigned). */
    async add(record: ScoreRecord, replay?: Uint8Array): Promise<ScoreRecord> {
        await this.init();
        if (this.writer) {
            try {
                if (await this.writer.add(record, replay)) return { ...record, hasReplay: !!replay, source: 'lazer' };
            } catch (e) {
                console.warn('[scores] external save failed; keeping it here', e);
            }
        }
        const rec: ScoreRecord = { ...record, mods: [...record.mods] };
        delete rec.id;
        delete rec.hasReplay;
        // Only valid, non-default settings of the score's own mods are kept.
        const settings = record.modSettings ? modSettingsOf(withSettings(record.mods, record.modSettings)) : {};
        if (Object.keys(settings).length) rec.modSettings = settings;
        else delete rec.modSettings;
        try {
            rec.id = await this.db!.scores.put(rec);
            if (replay) {
                // Written after the score (its key is the score's id); the flag only once it's stored.
                await this.db!.replays.put(replay, rec.id);
                rec.hasReplay = true;
                await this.db!.scores.put(rec);
            }
        } catch (e) {
            // Keep the score for this session even if persistence fails.
            console.warn('[scores] save failed', e);
        }
        this.records.push(rec);
        this.changed.emit(rec);
        return rec;
    }

    private external: ScoreRecord[] = [];
    private externalSource: ExternalScoreSource | null = null;

    /** Replace the scores listed from another client (they are never stored here). */
    setExternal(source: ExternalScoreSource | null, records: readonly ScoreRecord[]): void {
        this.externalSource = source;
        this.external = records.map(r => ({ ...r, source: r.source ?? 'lazer', hasReplay: true }));
        this.removed.emit();
    }

    /** An external score's .osr (null for local scores or a missing file). */
    async externalOsr(record: ScoreRecord): Promise<Uint8Array | null> {
        if (!record.source || !this.externalSource) return null;
        try {
            return await this.externalSource.osr(record);
        } catch (e) {
            console.warn('[scores] external replay load failed', e);
            return null;
        }
    }

    /** Whether this record can be deleted (local ones always; external ones when the source allows it). */
    canDelete(record: ScoreRecord): boolean {
        return record.source ? !!this.externalSource?.deleteScore && this.externalDeletable : record.id !== undefined;
    }

    /** Set by the owner of the external source: deleting its scores is allowed right now. */
    externalDeletable = false;

    /** Delete a local or (where allowed) external record. */
    async deleteRecord(record: ScoreRecord): Promise<void> {
        if (record.source) {
            if (!this.externalSource?.deleteScore) return;
            await this.externalSource.deleteScore(record);
            this.external = this.external.filter(r => r !== record && !(r.sourceId && r.sourceId === record.sourceId));
            this.removed.emit();
            return;
        }
        if (record.id !== undefined) await this.delete(record.id);
    }

    private get everything(): ScoreRecord[] {
        return this.external.length ? [...this.records, ...this.external] : this.records;
    }

    /** Scores on one difficulty, best first (ties: older first). */
    async forBeatmap(key: string): Promise<ScoreRecord[]> {
        await this.init();
        return this.everything
            .filter(r => r.beatmapKey === key)
            .sort((a, b) => b.score - a.score || a.date - b.date);
    }

    async best(key: string): Promise<ScoreRecord | null> {
        const list = await this.forBeatmap(key);
        return list.find(r => r.passed) ?? list[0] ?? null;
    }

    /** Most recent plays, newest first. */
    async recent(limit = 50): Promise<ScoreRecord[]> {
        await this.init();
        return [...this.everything].sort((a, b) => b.date - a.date).slice(0, limit);
    }

    async all(): Promise<ScoreRecord[]> {
        await this.init();
        return [...this.records];
    }

    /** A score's encoded replay (see gameplay/replay), or null when it has none. */
    async replay(id: number): Promise<Uint8Array | null> {
        await this.init();
        try {
            return (await this.db!.replays.get(id)) ?? null;
        } catch (e) {
            console.warn('[scores] replay load failed', e);
            return null;
        }
    }

    async delete(id: number): Promise<void> {
        await this.init();
        this.records = this.records.filter(r => r.id !== id);
        try {
            await this.db!.scores.delete(id);
            await this.db!.replays.delete(id);
        } catch (e) {
            console.warn('[scores] delete failed', e);
        }
        this.removed.emit();
    }

    async clear(): Promise<void> {
        await this.init();
        this.records = [];
        try {
            await this.db!.scores.clear();
            await this.db!.replays.clear();
        } finally {
            this.removed.emit();
        }
    }
}

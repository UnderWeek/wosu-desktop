/**
 * Per-beatmap audio offsets (osu!'s local offset / lazer's BeatmapUserSettings.Offset),
 * added on top of the global audio offset. Keyed like scores (beatmapKeyOf).
 */
import { openAppDatabase, type AppDatabase } from './idb';

const KEY = 'beatmapOffsets';

export class BeatmapOffsets {
    private offsets: Record<string, number> = {};
    private db: AppDatabase | null = null;
    private ready: Promise<void> | null = null;

    constructor(private readonly dbSource: AppDatabase | Promise<AppDatabase> = openAppDatabase()) {}

    init(): Promise<void> {
        this.ready ??= this.load();
        return this.ready;
    }

    private async load(): Promise<void> {
        const db = await this.dbSource;
        this.db = db;
        try {
            const stored = await db.kv.get(KEY);
            if (stored && typeof stored === 'object') {
                for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
                    if (typeof v === 'number' && Number.isFinite(v) && v !== 0) this.offsets[k] = v;
                }
            }
        } catch (e) {
            console.warn('[beatmap offsets] load failed', e);
        }
    }

    get(beatmapKey: string): number {
        return this.offsets[beatmapKey] ?? 0;
    }

    set(beatmapKey: string, ms: number): void {
        if (this.get(beatmapKey) === ms) return;
        if (ms === 0) delete this.offsets[beatmapKey];
        else this.offsets[beatmapKey] = ms;
        void this.db?.kv.put({ ...this.offsets }, KEY).catch(e => console.warn('[beatmap offsets] save failed', e));
    }
}

/**
 * The player's beatmap collections (osu!lazer's collections, which live
 * in realm). Stored as one array in the app database's key-value store,
 * plus the song select collection filter (lazer's
 * SongSelectCollectionFilter setting) so it survives reloads.
 */
import { Bindable } from '../core/Bindable';
import { Signal } from '../core/Signal';
import {
    cleanCollectionName,
    membershipOf,
    sanitizeCollections,
    sortCollections,
    type BeatmapCollection,
    type MembershipState,
} from '../beatmap/collections';
import { openAppDatabase, type AppDatabase } from './idb';

const KEY = 'collections';
const FILTER_KEY = 'collectionFilter';
/** Ids of mirrored collections the player deleted here (not brought back by the next sync). */
const REMOVED_EXTERNAL_KEY = 'collectionsRemovedExternal';
const EXTERNAL_PREFIX = 'lazer-';

let idCounter = 0;

function newId(): string {
    const c = (globalThis.crypto as Crypto | undefined);
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return `c${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Where mirrored (`lazer-…`) collections are written when the source is
 * writable (desktop: "store in osu!lazer"). Ids are the source's own,
 * without the prefix. A rejected write is reported and undone by the
 * next `syncExternal`.
 */
export interface CollectionWriter {
    create(name: string, items: readonly string[]): Promise<{ id: string }>;
    update(id: string, patch: { name?: string; items?: readonly string[] }): Promise<unknown>;
    remove(id: string): Promise<unknown>;
    /** A write failed: tell the player and re-read the source. */
    failed(e: unknown): void;
}

export class CollectionStore {
    /** Set while mirrored collections are written through (and the source is authoritative). */
    writer: CollectionWriter | null = null;
    private pendingId = 0;
    readonly changed = new Signal<[]>();
    /** Song select's collection filter: a collection id, or '' for all beatmaps. */
    readonly filter = new Bindable<string>('');
    private list: BeatmapCollection[] = [];
    private removedExternal = new Set<string>();
    private db: AppDatabase | null = null;
    private ready: Promise<void> | null = null;
    private loaded = false;
    /** Writes run in order so a slow put can't overwrite a newer one. */
    private writes: Promise<void> = Promise.resolve();

    constructor(private readonly dbSource: AppDatabase | Promise<AppDatabase> = openAppDatabase()) {
        this.filter.bind(v => {
            if (this.loaded) this.enqueue(db => db.kv.put(v, FILTER_KEY));
        });
    }

    init(): Promise<void> {
        this.ready ??= this.load();
        return this.ready;
    }

    get isLoaded(): boolean {
        return this.loaded;
    }

    private async load(): Promise<void> {
        try {
            const db = await this.dbSource;
            this.db = db;
            this.list = sanitizeCollections(await db.kv.get(KEY));
            const removed = await db.kv.get(REMOVED_EXTERNAL_KEY);
            if (Array.isArray(removed)) this.removedExternal = new Set(removed.filter((x): x is string => typeof x === 'string'));
            const f = await db.kv.get(FILTER_KEY);
            if (typeof f === 'string' && this.get(f)) this.filter.value = f;
        } catch (e) {
            console.warn('[collections] load failed', e);
        }
        this.loaded = true;
        this.changed.emit();
    }

    /** Collections ordered by name, like lazer's lists. */
    get all(): readonly BeatmapCollection[] {
        return sortCollections(this.list);
    }

    get size(): number {
        return this.list.length;
    }

    get(id: string): BeatmapCollection | undefined {
        return this.list.find(c => c.id === id);
    }

    /** Member keys of a collection as a set (for filtering); null when it doesn't exist. */
    members(id: string): ReadonlySet<string> | null {
        const c = this.get(id);
        return c ? new Set(c.items) : null;
    }

    has(id: string, key: string): boolean {
        return this.get(id)?.items.includes(key) ?? false;
    }

    membership(id: string, keys: readonly string[]): MembershipState {
        const c = this.get(id);
        return c ? membershipOf(c, keys) : 'none';
    }

    /** New collection (optionally with members). Returns null for an empty name. */
    create(name: string, items: readonly string[] = []): BeatmapCollection | null {
        const clean = cleanCollectionName(name);
        if (!clean) return null;
        if (this.writer) {
            // Shown at once; the source's real id replaces this one on the next sync.
            const c: BeatmapCollection = { id: `${EXTERNAL_PREFIX}pending-${++this.pendingId}`, name: clean, items: [...new Set(items)], createdAt: Date.now() };
            this.list.push(c);
            this.changed.emit();
            this.writer.create(clean, c.items).catch(e => this.writer?.failed(e));
            return c;
        }
        const c: BeatmapCollection = { id: newId(), name: clean, items: [...new Set(items)], createdAt: Date.now() };
        this.list.push(c);
        this.commit();
        return c;
    }

    rename(id: string, name: string): boolean {
        const c = this.get(id);
        const clean = cleanCollectionName(name);
        if (!c || !clean) return false;
        if (c.name === clean) return true;
        c.name = clean;
        this.commit();
        this.writeThrough(id, { name: clean });
        return true;
    }

    remove(id: string): boolean {
        const i = this.list.findIndex(c => c.id === id);
        if (i < 0) return false;
        this.list.splice(i, 1);
        if (this.filter.value === id) this.filter.value = '';
        if (this.writer && id.startsWith(EXTERNAL_PREFIX)) {
            if (!id.includes('pending-')) this.writer.remove(id.slice(EXTERNAL_PREFIX.length)).catch(e => this.writer?.failed(e));
        } else if (id.startsWith(EXTERNAL_PREFIX)) {
            this.removedExternal.add(id);
            const removed = [...this.removedExternal];
            this.enqueue(db => db.kv.put(removed, REMOVED_EXTERNAL_KEY));
        }
        this.commit();
        return true;
    }

    /**
     * Mirror collections kept by another client (osu!lazer's realm): each
     * becomes a normal collection here (id `lazer-…`). Syncing only adds:
     * members and collections the player removed in wosu! stay removed,
     * renames stick, and nothing is ever written back to the source.
     */
    async syncExternal(cols: readonly { id: string; name: string; items: readonly string[] }[]): Promise<void> {
        await this.init();
        if (this.writer) {
            // The source is authoritative: mirror it exactly (pending ones are replaced by their real rows).
            const keep = this.list.filter(c => !c.id.startsWith(EXTERNAL_PREFIX));
            const mirrored = cols.map(col => {
                const prev = this.get(EXTERNAL_PREFIX + col.id);
                return { id: EXTERNAL_PREFIX + col.id, name: cleanCollectionName(col.name) || col.name, items: [...new Set(col.items)], createdAt: prev?.createdAt ?? Date.now(), external: [...col.items] };
            });
            this.list = [...keep, ...mirrored];
            if (this.filter.value && !this.get(this.filter.value)) this.filter.value = '';
            this.commit();
            return;
        }
        let touched = false;
        for (const col of cols) {
            const id = EXTERNAL_PREFIX + col.id;
            if (this.removedExternal.has(id)) continue;
            const existing = this.get(id);
            if (existing) {
                // Only members new in the source since the last sync.
                const seen = new Set(existing.external ?? []);
                const have = new Set(existing.items);
                for (const k of col.items) {
                    if (seen.has(k) || have.has(k)) continue;
                    have.add(k);
                    existing.items.push(k);
                    touched = true;
                }
                if (!existing.external || existing.external.length !== col.items.length || col.items.some(k => !seen.has(k))) {
                    existing.external = [...col.items];
                    touched = true;
                }
                continue;
            }
            const name = cleanCollectionName(col.name);
            if (!name) continue;
            const items = [...new Set(col.items)];
            this.list.push({ id, name, items, createdAt: Date.now(), external: [...items] });
            touched = true;
        }
        if (touched) this.commit();
    }

    /** Add members (already present ones are skipped). Returns how many were added. */
    add(id: string, keys: readonly string[]): number {
        const c = this.get(id);
        if (!c) return 0;
        const have = new Set(c.items);
        let n = 0;
        for (const k of keys) {
            if (!k || have.has(k)) continue;
            have.add(k);
            c.items.push(k);
            n++;
        }
        if (n) {
            this.commit();
            this.writeThrough(id, { items: c.items });
        }
        return n;
    }

    /** Remove members. Returns how many were removed. */
    removeItems(id: string, keys: readonly string[]): number {
        const c = this.get(id);
        if (!c) return 0;
        const drop = new Set(keys);
        const before = c.items.length;
        c.items = c.items.filter(k => !drop.has(k));
        const n = before - c.items.length;
        if (n) {
            this.commit();
            this.writeThrough(id, { items: c.items });
        }
        return n;
    }

    /** A mirrored collection's change, written to its source. */
    private writeThrough(id: string, patch: { name?: string; items?: readonly string[] }): void {
        if (!this.writer || !id.startsWith(EXTERNAL_PREFIX) || id.includes('pending-')) return;
        this.writer.update(id.slice(EXTERNAL_PREFIX.length), { ...patch, ...(patch.items ? { items: [...patch.items] } : {}) }).catch(e => this.writer?.failed(e));
    }

    /** Resolves once every write queued so far has been attempted. */
    flush(): Promise<void> {
        return this.writes;
    }

    private commit(): void {
        this.changed.emit();
        const snapshot = this.list.map(c => ({ ...c, items: [...c.items], ...(c.external ? { external: [...c.external] } : {}) }));
        this.enqueue(db => db.kv.put(snapshot, KEY));
    }

    private enqueue(write: (db: AppDatabase) => Promise<unknown>): void {
        this.writes = this.writes.then(async () => {
            try {
                const db = this.db ?? (await this.dbSource);
                await write(db);
            } catch (e) {
                console.warn('[collections] save failed', e);
            }
        });
    }
}

let shared: CollectionStore | null = null;

/** The app-wide collection store (opened on first use). */
export function collections(): CollectionStore {
    if (!shared) {
        shared = new CollectionStore();
        void shared.init();
    }
    return shared;
}

/**
 * `Database` backed by files under ~/.wosu, served by the desktop shell
 * (electron/storage.cjs). Same API as the IndexedDB one in idb.ts.
 */
import type { WireValue, WosuNative } from '../native/native';
import type { Database, KeyValueStore, StoreSchema } from './idb';

async function toWire(value: unknown): Promise<WireValue> {
    if (value instanceof Blob) return { t: 'blob', type: value.type, bytes: new Uint8Array(await value.arrayBuffer()) };
    return { t: 'v', v: value };
}

function fromWire<V>(w: WireValue | undefined): V | undefined {
    if (!w) return undefined;
    if (w.t === 'blob') return new Blob([w.bytes as Uint8Array<ArrayBuffer>], { type: w.type }) as V;
    return w.v as V;
}

class FsStore<K extends IDBValidKey, V> implements KeyValueStore<K, V> {
    constructor(private readonly native: WosuNative, private readonly db: string, private readonly schema: StoreSchema) {}

    async get(key: K): Promise<V | undefined> {
        return fromWire<V>(await this.native.db.get(this.db, this.schema.name, key));
    }

    async put(value: V, key?: K): Promise<K> {
        const schema = { keyPath: this.schema.keyPath, autoIncrement: this.schema.autoIncrement };
        return (await this.native.db.put(this.db, this.schema.name, schema, await toWire(value), key)) as K;
    }

    delete(key: K): Promise<void> {
        return this.native.db.delete(this.db, this.schema.name, key);
    }

    async getAll(): Promise<V[]> {
        return (await this.native.db.entries(this.db, this.schema.name)).map(e => fromWire<V>(e.value) as V);
    }

    async keys(): Promise<K[]> {
        return (await this.native.db.keys(this.db, this.schema.name)) as K[];
    }

    clear(): Promise<void> {
        return this.native.db.clear(this.db, this.schema.name);
    }

    count(): Promise<number> {
        return this.native.db.count(this.db, this.schema.name);
    }
}

export class FsDatabase implements Database {
    readonly persistent = true;
    private readonly stores = new Map<string, KeyValueStore<IDBValidKey, unknown>>();

    constructor(native: WosuNative, name: string, schemas: readonly StoreSchema[]) {
        for (const s of schemas) this.stores.set(s.name, new FsStore(native, name, s));
    }

    store<K extends IDBValidKey, V>(name: string): KeyValueStore<K, V> {
        const s = this.stores.get(name);
        if (!s) throw new Error(`unknown store ${name}`);
        return s as unknown as KeyValueStore<K, V>;
    }

    close(): void {
        /* nothing to release */
    }
}

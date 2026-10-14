/**
 * File-system key/value stores behind the renderer's `Database` API
 * (src/storage/fsdb.ts). Every IndexedDB store the game opens maps to a
 * folder under ~/.wosu:
 *
 *   webosu/blobs      -> Songs/<key>.osz        (beatmap archives)
 *   wosu-skins/files  -> Skins/<id>.osk         (skin archives)
 *   webosu/thumbs     -> cache/thumbs/<key>.jpg
 *   anything else     -> data/<db>/<store>/<key>.bin (v8-serialized values)
 *
 * Values cross IPC as a "wire" value: { t: 'blob', type, bytes } for
 * Blobs (IPC cannot carry Blob) or { t: 'v', v } for anything else.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const v8 = require('node:v8');

const DATA_DIR = process.env.WOSU_DATA_DIR || path.join(os.homedir(), '.wosu');
const SONGS_DIR = path.join(DATA_DIR, 'Songs');
const SKINS_DIR = path.join(DATA_DIR, 'Skins');

/** Stores kept as plain files the player can see and copy. */
const RAW = {
    'webosu/blobs': { dir: SONGS_DIR, ext: '.osz', type: 'application/octet-stream' },
    'wosu-skins/files': { dir: SKINS_DIR, ext: '.osk', type: 'application/octet-stream' },
    'webosu/thumbs': { dir: path.join(DATA_DIR, 'cache', 'thumbs'), ext: '.jpg', type: 'image/jpeg' },
};

/** Identifiers that are safe as (part of) a path segment. */
function safeName(s) {
    return String(s).replace(/[^A-Za-z0-9_-]/g, '_');
}

function storeOf(db, store) {
    const raw = RAW[`${db}/${store}`];
    if (raw) return { raw: true, ...raw };
    return { raw: false, dir: path.join(DATA_DIR, 'data', safeName(db), safeName(store)), ext: '.bin' };
}

// Keys: numbers and strings stay distinct (like IndexedDB).
function encodeKey(key, raw) {
    if (typeof key === 'number') return `n~${key}`;
    const s = String(key);
    if (raw && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)) return s;
    return `s~${encodeURIComponent(s).replace(/\./g, '%2E')}`;
}

function decodeKey(name) {
    if (name.startsWith('n~')) return Number(name.slice(2));
    if (name.startsWith('s~')) return decodeURIComponent(name.slice(2));
    return name;
}

/** IndexedDB key order: numbers before strings. */
function compareKeys(a, b) {
    const ta = typeof a, tb = typeof b;
    if (ta !== tb) return ta === 'number' ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
}

function fileFor(s, key) {
    return path.join(s.dir, encodeKey(key, s.raw) + s.ext);
}

async function listKeys(s) {
    let names;
    try {
        names = await fsp.readdir(s.dir);
    } catch {
        return [];
    }
    return names
        .filter(n => n.endsWith(s.ext) && !n.startsWith('.'))
        .map(n => decodeKey(n.slice(0, -s.ext.length)))
        .filter(k => s.raw ? isOwnedRawKey(s, k) : true)
        .sort(compareKeys);
}

/**
 * Raw folders are shared with the player: only names the game itself
 * writes count as stored entries; anything else is an import (inbox.cjs).
 */
function isOwnedRawKey(s, key) {
    if (s.dir === SONGS_DIR) return /^(osu-\d+|local-[0-9a-f]+)$/.test(key);
    if (s.dir === SKINS_DIR) return /^skin-[0-9a-f]{16}$/.test(key);
    return true;
}

async function readWire(s, file) {
    let buf;
    try {
        buf = await fsp.readFile(file);
    } catch (e) {
        if (e.code === 'ENOENT') return undefined;
        throw e;
    }
    if (s.raw) return { t: 'blob', type: s.type, bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
    return v8.deserialize(buf);
}

/** Write via a temp file + rename so a crash never leaves half a file. */
async function writeAtomic(file, data) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
}

/** Next auto-increment id per store, seeded from the largest numeric key on disk. */
const counters = new Map();
async function nextId(s) {
    let n = counters.get(s.dir);
    if (n === undefined) {
        n = 1;
        for (const k of await listKeys(s)) if (typeof k === 'number' && k >= n) n = Math.floor(k) + 1;
    }
    counters.set(s.dir, n + 1);
    return n;
}

function bumpCounter(s, key) {
    if (typeof key !== 'number') return;
    const n = counters.get(s.dir);
    if (n !== undefined && key >= n) counters.set(s.dir, Math.floor(key) + 1);
}

// Writes to one file are serialized (put/delete races on the same key).
const locks = new Map();
function withLock(file, fn) {
    const prev = locks.get(file) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.catch(() => {});
    locks.set(file, settled);
    settled.then(() => { if (locks.get(file) === settled) locks.delete(file); });
    return run;
}

const api = {
    async get(db, store, key) {
        const s = storeOf(db, store);
        return readWire(s, fileFor(s, key));
    },

    async put(db, store, schema, wire, key) {
        const s = storeOf(db, store);
        if (schema.keyPath) {
            if (wire.t !== 'v' || typeof wire.v !== 'object' || wire.v === null) throw new Error(`store ${store}: in-line key needs an object value`);
            key = wire.v[schema.keyPath];
            if (key === undefined && schema.autoIncrement) {
                key = await nextId(s);
                wire = { t: 'v', v: { ...wire.v, [schema.keyPath]: key } };
            }
        } else if (key === undefined && schema.autoIncrement) {
            key = await nextId(s);
        }
        if (key === undefined || key === null) throw new Error(`store ${store}: missing key`);
        bumpCounter(s, key);
        const file = fileFor(s, key);
        let data;
        if (s.raw) {
            if (wire.t !== 'blob') throw new Error(`store ${store}: expected a Blob`);
            data = wire.bytes;
        } else {
            data = v8.serialize(wire);
        }
        await withLock(file, () => writeAtomic(file, data));
        return key;
    },

    async delete(db, store, key) {
        const s = storeOf(db, store);
        const file = fileFor(s, key);
        await withLock(file, () => fsp.rm(file, { force: true }));
    },

    async entries(db, store) {
        const s = storeOf(db, store);
        const out = [];
        for (const key of await listKeys(s)) {
            try {
                const value = await readWire(s, fileFor(s, key));
                if (value !== undefined) out.push({ key, value });
            } catch (e) {
                console.warn(`[storage] unreadable ${db}/${store}/${key}`, e);
            }
        }
        return out;
    },

    async keys(db, store) {
        return listKeys(storeOf(db, store));
    },

    async clear(db, store) {
        const s = storeOf(db, store);
        await Promise.all((await listKeys(s)).map(k => api.delete(db, store, k)));
    },

    async count(db, store) {
        return (await listKeys(storeOf(db, store))).length;
    },
};

function registerIpc(ipcMain) {
    for (const [name, fn] of Object.entries(api)) {
        ipcMain.handle(`wosu:db:${name}`, (_e, ...args) => fn(...args));
    }
}

for (const d of [SONGS_DIR, SKINS_DIR]) fs.mkdirSync(d, { recursive: true });

module.exports = { DATA_DIR, SONGS_DIR, SKINS_DIR, registerIpc, isOwnedRawKey, storeOf };

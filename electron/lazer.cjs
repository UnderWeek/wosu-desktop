/**
 * Read-only access to an osu!lazer install: beatmaps and skins are
 * listed from its client.realm and their files read straight from its
 * content-addressed store (files/a/ab/<sha256>). Nothing is copied
 * except a snapshot of the 45-ish MB database, so lazer can keep it open.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DATA_DIR } = require('./storage.cjs');

const DEFAULT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'osu');
const SNAPSHOT_DIR = path.join(DATA_DIR, 'cache', 'lazer');
const HASH = /^[0-9a-f]{64}$/;

/** lazer's data folder; storage.ini can move it ("FullPath = ..."). */
function lazerDir() {
    // Tests point this at a copy (never the real install).
    if (process.env.WOSU_LAZER_DIR) return process.env.WOSU_LAZER_DIR;
    try {
        const ini = fs.readFileSync(path.join(DEFAULT_DIR, 'storage.ini'), 'utf8');
        const m = /^\s*FullPath\s*=\s*(.+?)\s*$/m.exec(ini);
        if (m && fs.existsSync(path.join(m[1], 'client.realm'))) return m[1];
    } catch { /* no custom location */ }
    return DEFAULT_DIR;
}

function filePath(dir, hash) {
    return path.join(dir, 'files', hash[0], hash.slice(0, 2), hash);
}

/** Copy client.realm when it changed since the last snapshot. */
async function snapshot(dir) {
    const src = path.join(dir, 'client.realm');
    const st = await fsp.stat(src);
    await fsp.mkdir(SNAPSHOT_DIR, { recursive: true });
    const dest = path.join(SNAPSHOT_DIR, 'client.realm');
    const stampFile = path.join(SNAPSHOT_DIR, 'source.json');
    const stamp = JSON.stringify({ mtime: st.mtimeMs, size: st.size });
    let old = '';
    try { old = await fsp.readFile(stampFile, 'utf8'); } catch { /* first run */ }
    if (old !== stamp || !fs.existsSync(dest)) {
        // Realm's side files belong to the previous copy.
        for (const n of await fsp.readdir(SNAPSHOT_DIR)) await fsp.rm(path.join(SNAPSHOT_DIR, n), { recursive: true, force: true });
        await fsp.copyFile(src, dest);
        await fsp.writeFile(stampFile, stamp);
    }
    return dest;
}

async function sizeOf(dir, hash) {
    try {
        return (await fsp.stat(filePath(dir, hash))).size;
    } catch {
        return 0;
    }
}

let cache = null; // { stamp, data }

/**
 * Everything wosu! needs from the database, as plain data:
 * sets (files + which .osu are osu!standard + lazer's star ratings) and
 * skins that have files (lazer's built-in skins have none).
 */
async function library() {
    const dir = lazerDir();
    if (!fs.existsSync(path.join(dir, 'client.realm'))) return { available: false, dir, sets: [], skins: [], collections: [], scores: [], username: null };
    const realmPath = await snapshot(dir);
    const stamp = (await fsp.stat(realmPath)).mtimeMs;
    if (cache && cache.stamp === stamp && cache.dir === dir) return cache.data;

    const Realm = require('realm');
    const realm = await Realm.open({ path: realmPath, readOnly: true });
    const sets = [], skins = [], collections = [], scores = [];
    let newestUser = null;
    const sizes = [];
    try {
        for (const s of realm.objects('BeatmapSet')) {
            if (s.DeletePending) continue;
            const files = [];
            for (const f of s.Files) {
                const hash = f.File?.Hash;
                if (typeof hash === 'string' && HASH.test(hash)) files.push({ name: f.Filename, hash, size: 0 });
            }
            const beatmaps = [];
            for (const b of s.Beatmaps) {
                if (b.Ruleset?.ShortName !== 'osu' || b.Hidden) continue;
                beatmaps.push({ hash: b.Hash, md5: b.MD5Hash, onlineId: b.OnlineID, stars: b.StarRating });
            }
            if (!beatmaps.length || !files.length) continue;
            sets.push({ id: String(s.ID), onlineId: s.OnlineID, hash: s.Hash, files, beatmaps });
        }
        for (const s of realm.objects('Skin')) {
            if (s.DeletePending || !s.Files.length) continue;
            const files = [];
            for (const f of s.Files) {
                const hash = f.File?.Hash;
                if (typeof hash === 'string' && HASH.test(hash)) files.push({ name: f.Filename, hash, size: 0 });
            }
            skins.push({ id: String(s.ID), name: s.Name, creator: s.Creator, hash: s.Hash, files });
        }
        for (const c of realm.objects('BeatmapCollection')) {
            collections.push({ id: String(c.ID), name: c.Name, md5s: [...c.BeatmapMD5Hashes] });
        }
        newestUser = realm.objects('Score').sorted('Date', true)[0]?.User?.Username || null;
        // Local osu!standard scores that kept a replay.
        for (const s of realm.objects('Score')) {
            if (s.DeletePending || s.Ruleset?.ShortName !== 'osu') continue;
            const replay = [...s.Files].find(f => /\.osr$/i.test(f.Filename) && HASH.test(f.File?.Hash ?? ''));
            if (!replay) continue;
            scores.push({
                id: String(s.ID),
                md5: s.BeatmapInfo?.MD5Hash ?? s.BeatmapHash ?? '',
                total: s.TotalScore,
                accuracy: s.Accuracy,
                maxCombo: s.MaxCombo,
                rank: s.Rank,
                date: s.Date instanceof Date ? s.Date.getTime() : Date.parse(String(s.Date)),
                mods: typeof s.Mods === 'string' ? s.Mods : JSON.stringify(s.Mods ?? []),
                statistics: typeof s.Statistics === 'string' ? s.Statistics : JSON.stringify(s.Statistics ?? {}),
                user: typeof s.User === 'string' ? s.User : JSON.stringify(s.User ?? {}),
                replayHash: replay.File.Hash,
            });
        }
    } finally {
        realm.close();
    }
    // Sizes (the database does not store them): one stat per file.
    for (const s of [...sets, ...skins]) for (const f of s.files) sizes.push(f);
    for (let i = 0; i < sizes.length; i += 256) {
        await Promise.all(sizes.slice(i, i + 256).map(async f => { f.size = await sizeOf(dir, f.hash); }));
    }
    // The player's name as lazer knows it: its newest local score's user.
    const data = { available: true, dir, sets, skins, collections, scores, username: newestUser };
    cache = { stamp, dir, data };
    return data;
}

async function read(hash) {
    if (typeof hash !== 'string' || !HASH.test(hash)) throw new Error('bad file hash');
    const buf = await fsp.readFile(filePath(lazerDir(), hash));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function registerIpc(ipcMain) {
    ipcMain.handle('wosu:lazer:library', () => library());
    ipcMain.handle('wosu:lazer:read', (_e, hash) => read(hash));
}

module.exports = { registerIpc, lazerDir, filePath, invalidate: () => { cache = null; } };

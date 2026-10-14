/**
 * Files the player puts into ~/.wosu/Songs or ~/.wosu/Skins themselves
 * (.osz/.osk/.zip archives, or extracted beatmap/skin folders as osu!
 * stable keeps them). The renderer lists them, imports them through the
 * normal importer (which writes its own copy under a stored name), then
 * moves the original to the Trash.
 */
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const { shell } = require('electron');
const { zipSync } = require('fflate');
const { SONGS_DIR, SKINS_DIR, isOwnedRawKey, storeOf } = require('./storage.cjs');

const ARCHIVE = /\.(osz|osk|zip)$/i;
/** A file still being copied in: wait until it has been quiet this long. */
const SETTLE_MS = 2000;

const songsStore = storeOf('webosu', 'blobs');
const skinsStore = storeOf('wosu-skins', 'files');

function isOwned(dir, name) {
    const s = dir === SONGS_DIR ? songsStore : skinsStore;
    return name.endsWith(s.ext) && isOwnedRawKey(s, name.slice(0, -s.ext.length));
}

async function list() {
    const out = [];
    let settling = false;
    for (const dir of [SONGS_DIR, SKINS_DIR]) {
        let ents;
        try {
            ents = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const ent of ents) {
            if (ent.name.startsWith('.') || isOwned(dir, ent.name)) continue;
            const full = path.join(dir, ent.name);
            const isDir = ent.isDirectory();
            if (!isDir && !(ent.isFile() && ARCHIVE.test(ent.name))) continue;
            const st = await fsp.stat(full).catch(() => null);
            if (!st) continue;
            if (Date.now() - st.mtimeMs < SETTLE_MS) {
                settling = true;
                continue;
            }
            out.push({
                path: full,
                // Folders are zipped on read; give them the extension the importer expects.
                name: isDir ? ent.name + (dir === SKINS_DIR ? '.osk' : '.osz') : ent.name,
                folder: dir === SKINS_DIR ? 'skins' : 'songs',
            });
        }
    }
    // Something is still being copied: look again once it settles.
    if (settling) scheduleNotify(SETTLE_MS + 200);
    return out;
}

function checkPath(p) {
    const full = path.resolve(p);
    const dir = path.dirname(full);
    if (dir !== SONGS_DIR && dir !== SKINS_DIR) throw new Error('outside the wosu folders');
    return full;
}

async function zipFolder(root) {
    const files = {};
    async function walk(dir, rel) {
        for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
            if (ent.name === '.DS_Store') continue;
            const full = path.join(dir, ent.name);
            const r = rel ? `${rel}/${ent.name}` : ent.name;
            if (ent.isDirectory()) await walk(full, r);
            else if (ent.isFile()) files[r] = new Uint8Array(await fsp.readFile(full));
        }
    }
    await walk(root, '');
    // Store only: audio and images are already compressed.
    return zipSync(files, { level: 0 });
}

async function read(p) {
    const full = checkPath(p);
    const st = await fsp.stat(full);
    if (st.isDirectory()) return zipFolder(full);
    const buf = await fsp.readFile(full);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Imported: the stored copy replaces the original. */
async function done(p) {
    const full = checkPath(p);
    try {
        await shell.trashItem(full);
    } catch {
        await fsp.rm(full, { recursive: true, force: true });
    }
}

/** A file opened with the app (Finder double-click, dock drop): copy it into the inbox. */
async function adopt(file) {
    const name = path.basename(file);
    // Replays are watched straight away, not imported.
    if (/\.osr$/i.test(name)) {
        const bytes = new Uint8Array(await fsp.readFile(file));
        // Held until the game listens (a launch by double-click comes before it booted).
        openQueue.push({ name, bytes });
        flushOpen();
        return;
    }
    if (!ARCHIVE.test(name)) return;
    const dir = /\.osk$/i.test(name) ? SKINS_DIR : SONGS_DIR;
    let dest = path.join(dir, name);
    if (isOwned(dir, name) || fs.existsSync(dest)) dest = path.join(dir, `${Date.now()} ${name}`);
    await fsp.copyFile(file, dest);
    // Backdate so the settle check does not delay it.
    const old = new Date(Date.now() - SETTLE_MS * 2);
    await fsp.utimes(dest, old, old).catch(() => {});
    scheduleNotify(100);
}

let target = null;
const openQueue = [];
let openReady = false;

function flushOpen() {
    if (!openReady || !target || target.isDestroyed()) return;
    for (const f of openQueue.splice(0)) target.webContents.send('wosu:open-file', f);
}
let timer = null;
function scheduleNotify(ms = 1500) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
        timer = null;
        if (target && !target.isDestroyed()) target.webContents.send('wosu:inbox-changed');
    }, ms);
}

function attach(win) {
    target = win;
    openReady = false;
    // A reload starts a new page that has to ask again.
    win.webContents.on('did-start-navigation', (_e, _url, inPlace, isMainFrame) => {
        if (isMainFrame && !inPlace) openReady = false;
    });
}

for (const dir of [SONGS_DIR, SKINS_DIR]) {
    try {
        fs.watch(dir, (_event, name) => {
            // Our own temp files from atomic writes are not interesting.
            if (name && String(name).startsWith('.')) return;
            scheduleNotify();
        });
    } catch (e) {
        console.warn('[inbox] cannot watch', dir, e);
    }
}

function registerIpc(ipcMain) {
    ipcMain.handle('wosu:inbox:list', () => list());
    ipcMain.handle('wosu:inbox:read', (_e, p) => read(p));
    ipcMain.handle('wosu:inbox:done', (_e, p) => done(p));
    ipcMain.on('wosu:open-file-ready', () => {
        openReady = true;
        flushOpen();
    });
}

module.exports = { registerIpc, attach, adopt };

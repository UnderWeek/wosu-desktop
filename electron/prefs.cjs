/**
 * The game's localStorage (settings, last beatmap, …) as a file both
 * builds share: ~/.wosu/localstorage.json. Electron's own localStorage
 * lives in its Chromium profile, which the SDL build can't read.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./storage.cjs');

const FILE = path.join(DATA_DIR, 'localstorage.json');

let data = null;

function load() {
    if (data) return data;
    try {
        const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        data = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        data = null;
    }
    return data;
}

/** { exists, data }: exists is false before the first save (the game seeds it then). */
function snapshot() {
    const d = load();
    return { exists: d !== null, data: d ?? {} };
}

let timer = null;
function persist() {
    // Coalesce bursts of writes; flush synchronously on exit.
    if (timer) return;
    timer = setTimeout(flush, 200);
}

function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!data) return;
    const tmp = `${FILE}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, FILE);
    } catch (e) {
        console.warn('[prefs] save failed', e);
    }
}

function set(key, value) {
    data ??= {};
    data[String(key)] = String(value);
    persist();
}

function remove(key) {
    if (!data) return;
    delete data[String(key)];
    persist();
}

function replaceAll(all) {
    data = { ...all };
    flush();
}

process.on('exit', flush);

function registerIpc(ipcMain) {
    ipcMain.on('wosu:ls:snapshot', e => { e.returnValue = snapshot(); });
    ipcMain.on('wosu:ls:set', (_e, k, v) => set(k, v));
    ipcMain.on('wosu:ls:remove', (_e, k) => remove(k));
    ipcMain.on('wosu:ls:replaceAll', (_e, all) => replaceAll(all));
}

module.exports = { registerIpc, snapshot, set, remove, replaceAll, flush, FILE };

/**
 * window.wosuNative for the SDL host: the same bridge the Electron preload
 * exposes, backed by the Electron-free modules in ../electron (storage,
 * config, osu!lazer read/write). Shell-only parts (menu bar, dock,
 * updater) are no-ops here.
 */
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * The few Electron APIs the shared modules touch (inbox.cjs: shell),
 * done with macOS tools so those modules run unchanged here.
 */
const Module = require('node:module');
const fakeElectron = {
    shell: {
        trashItem: p => new Promise((resolve, reject) => execFile('/usr/bin/osascript', ['-e', `tell application "Finder" to delete (POSIX file ${JSON.stringify(p)} as alias)`], e => (e ? reject(e) : resolve()))),
        openPath: async p => { execFile('/usr/bin/open', [p]); return ''; },
        showItemInFolder: p => execFile('/usr/bin/open', ['-R', p]),
    },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
    return request === 'electron' ? fakeElectron : origLoad.call(this, request, ...rest);
};
const EL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron');

/** The modules register IPC handlers; collect them and call them directly. */
const handlers = new Map();
const fakeIpc = {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
};
const storage = require(path.join(EL, 'storage.cjs'));
const config = require(path.join(EL, 'config.cjs'));
const lazer = require(path.join(EL, 'lazer.cjs'));
const lazerWrite = require(path.join(EL, 'lazer-write.cjs'));
const prefs = require(path.join(EL, 'prefs.cjs'));
storage.registerIpc(fakeIpc);
lazer.registerIpc(fakeIpc);
lazerWrite.registerIpc(fakeIpc);
const inbox = require(path.join(EL, 'inbox.cjs'));
inbox.registerIpc(fakeIpc);
/** inbox.cjs notifies a window's webContents; collect those notifications instead. */
const inboxListeners = new Set();
inbox.attach({
    isDestroyed: () => false,
    webContents: {
        send: (ch, payload) => {
            if (ch === 'wosu:inbox-changed') for (const fn of inboxListeners) fn();
            if (ch === 'wosu:open-file') for (const fn of openFileHook) fn(payload);
        },
        on: () => {},
    },
});
const openFileHook = new Set();

const call = ch => async (...args) => {
    const fn = handlers.get(ch);
    if (!fn) throw new Error(`no handler for ${ch}`);
    return fn({}, ...args);
};
const noopListen = () => () => {};

/** Where the game's "downloads" go, as in electron/system.cjs. */
function saveDirFor(name) {
    if (/\.(png|jpe?g)$/i.test(name)) return 'Screenshots';
    if (/\.osr$/i.test(name)) return 'Replays';
    return 'Exports';
}

export function createNative({ onConfigChange } = {}) {
    const openFileListeners = new Set();
    const savedListeners = new Set();
    return {
        /** Host side: a file the game offered for download (screenshot, replay, export). */
        saveDownload(name, bytes) {
            const folder = saveDirFor(name);
            const dir = path.join(storage.DATA_DIR, folder);
            fs.mkdirSync(dir, { recursive: true });
            const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
            let file = path.join(dir, name);
            for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base} (${i})${ext}`);
            fs.writeFileSync(file, bytes);
            for (const fn of savedListeners) fn({ path: file, folder });
        },
        /** Host side: hand a dropped/opened file to the game (it imports or watches it). */
        openFile(f) {
            for (const fn of openFileListeners) fn(f);
        },
        platform: process.platform,
        debug: !!process.env.WOSU_DEBUG,
        db: {
            get: call('wosu:db:get'), put: call('wosu:db:put'), delete: call('wosu:db:delete'),
            entries: call('wosu:db:entries'), keys: call('wosu:db:keys'), clear: call('wosu:db:clear'), count: call('wosu:db:count'),
        },
        // Folder import (~/.wosu/Songs, Skins) needs Electron's trash; not wired here yet.
        inbox: {
            list: call('wosu:inbox:list'),
            read: call('wosu:inbox:read'),
            done: call('wosu:inbox:done'),
            onChanged: fn => {
                inboxListeners.add(fn);
                return () => inboxListeners.delete(fn);
            },
        },
        update: { check: async () => ({ current: 'sdl', available: false, error: 'Updates are not available in the SDL build' }), install: async () => {}, onProgress: noopListen },
        openDataDir: async () => { execFile('/usr/bin/open', [storage.DATA_DIR]); return ''; },
        config: {
            initial: config.get(),
            set: async patch => {
                const next = config.set(patch);
                onConfigChange?.(next);
                return next;
            },
            onChanged: noopListen,
        },
        relaunch: async () => relaunch(),
        localStore: {
            snapshot: () => prefs.snapshot(),
            set: (k, v) => prefs.set(k, v),
            remove: k => prefs.remove(k),
            replaceAll: all => prefs.replaceAll(all),
        },
        onMenu: noopListen,
        onFileSaved: fn => {
            savedListeners.add(fn);
            return () => savedListeners.delete(fn);
        },
        onOpenFile: fn => {
            openFileListeners.add(fn);
            return () => openFileListeners.delete(fn);
        },
        showInFolder: async p => { execFile('/usr/bin/open', ['-R', p]); },
        setPlaying: () => {},
        setDockProgress: () => {},
        notify: () => {},
        lazer: {
            library: call('wosu:lazer:library'), read: call('wosu:lazer:read'), running: call('wosu:lazer:running'),
            importBeatmapSet: call('wosu:lazer:importBeatmapSet'), importSkin: call('wosu:lazer:importSkin'), addScore: call('wosu:lazer:addScore'),
            createCollection: call('wosu:lazer:createCollection'), updateCollection: call('wosu:lazer:updateCollection'),
            deleteCollection: call('wosu:lazer:deleteCollection'), delete: call('wosu:lazer:delete'),
        },
    };
}

/** Start a fresh host (same command and environment) and exit this one. */
export function relaunch() {
    prefs.flush();
    spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { detached: true, stdio: 'ignore', env: process.env, cwd: process.cwd() }).unref();
    process.exit(0);
}

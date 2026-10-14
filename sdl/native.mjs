/**
 * window.wosuNative for the SDL host: the same bridge the Electron preload
 * exposes, backed by the Electron-free modules in ../electron (storage,
 * config, osu!lazer read/write). Shell-only parts (menu bar, dock,
 * updater) are no-ops here.
 */
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
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
storage.registerIpc(fakeIpc);
lazer.registerIpc(fakeIpc);
lazerWrite.registerIpc(fakeIpc);

const call = ch => async (...args) => {
    const fn = handlers.get(ch);
    if (!fn) throw new Error(`no handler for ${ch}`);
    return fn({}, ...args);
};
const noopListen = () => () => {};

export function createNative({ onConfigChange } = {}) {
    return {
        platform: process.platform,
        debug: !!process.env.WOSU_DEBUG,
        db: {
            get: call('wosu:db:get'), put: call('wosu:db:put'), delete: call('wosu:db:delete'),
            entries: call('wosu:db:entries'), keys: call('wosu:db:keys'), clear: call('wosu:db:clear'), count: call('wosu:db:count'),
        },
        // Folder import (~/.wosu/Songs, Skins) needs Electron's trash; not wired here yet.
        inbox: { list: async () => [], read: async () => new Uint8Array(), done: async () => {}, onChanged: noopListen },
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
        relaunch: async () => process.exit(0),
        onMenu: noopListen,
        onFileSaved: noopListen,
        onOpenFile: noopListen,
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

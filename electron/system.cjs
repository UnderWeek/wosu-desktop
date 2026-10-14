/**
 * macOS integration: where saved files go, the dock (download progress
 * and badge), system notifications, and keeping the Mac awake in play.
 */
const fs = require('node:fs');
const path = require('node:path');
const { app, Notification, powerSaveBlocker, shell } = require('electron');
const { DATA_DIR } = require('./storage.cjs');

/** Files the game "downloads" (screenshots, replays, exports) land here instead of a save dialog. */
const SAVE_DIRS = {
    screenshot: path.join(DATA_DIR, 'Screenshots'),
    replay: path.join(DATA_DIR, 'Replays'),
    export: path.join(DATA_DIR, 'Exports'),
};

function saveDirFor(filename) {
    if (/\.(png|jpe?g)$/i.test(filename)) return SAVE_DIRS.screenshot;
    if (/\.osr$/i.test(filename)) return SAVE_DIRS.replay;
    return SAVE_DIRS.export;
}

/** "name.png", or "name (2).png" when taken. */
function uniquePath(dir, filename) {
    const ext = path.extname(filename);
    const base = filename.slice(0, filename.length - ext.length);
    let p = path.join(dir, filename);
    for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
    return p;
}

let win = null;

function routeDownloads(session) {
    session.on('will-download', (_e, item) => {
        const dir = saveDirFor(item.getFilename());
        fs.mkdirSync(dir, { recursive: true });
        const target = uniquePath(dir, item.getFilename());
        item.setSavePath(target);
        item.once('done', (_ev, state) => {
            if (state === 'completed' && win && !win.isDestroyed()) {
                win.webContents.send('wosu:file-saved', { path: target, folder: path.relative(DATA_DIR, dir) });
            }
        });
    });
}

let sleepBlocker = null;
function setPlaying(playing) {
    if (playing && sleepBlocker === null) {
        sleepBlocker = powerSaveBlocker.start('prevent-display-sleep');
    } else if (!playing && sleepBlocker !== null) {
        powerSaveBlocker.stop(sleepBlocker);
        sleepBlocker = null;
    }
}

/** Dock progress bar (0..1; negative removes it) and badge text. */
function setDockProgress(progress, badge) {
    if (win && !win.isDestroyed()) win.setProgressBar(progress >= 0 ? progress : -1);
    if (app.dock) app.dock.setBadge(badge || '');
}

/** A system notification, only while the game is not in front (in-game toasts cover the rest). */
function notify(title, body) {
    if (!Notification.isSupported()) return;
    if (win && !win.isDestroyed() && win.isFocused()) return;
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => {
        if (!win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    });
    n.show();
}

function attach(w) {
    win = w;
    // Never leave the display awake after the window is gone.
    w.on('closed', () => setPlaying(false));
}

function registerIpc(ipcMain) {
    ipcMain.on('wosu:set-playing', (_e, playing) => setPlaying(!!playing));
    ipcMain.on('wosu:dock-progress', (_e, progress, badge) => setDockProgress(Number(progress), String(badge ?? '')));
    ipcMain.on('wosu:notify', (_e, title, body) => notify(String(title), String(body ?? '')));
    ipcMain.handle('wosu:show-in-folder', (_e, p) => {
        const full = path.resolve(String(p));
        if (full.startsWith(DATA_DIR + path.sep)) shell.showItemInFolder(full);
    });
}

module.exports = { attach, registerIpc, routeDownloads };

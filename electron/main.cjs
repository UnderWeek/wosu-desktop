/**
 * wosu! desktop shell (Electron main process).
 *
 * - Serves the Vite build from a privileged `wosu://app/` origin (secure
 *   context, fetch-able, same behaviour as the hosted site).
 * - Keeps everything the game stores under ~/.wosu: beatmaps in
 *   ~/.wosu/Songs, skins in ~/.wosu/Skins, the rest in ~/.wosu/data, and
 *   the Chromium profile (settings in localStorage) in ~/.wosu/.electron.
 * - Watches Songs/Skins for files the player drops in and hands them to
 *   the game for import.
 * - One-click updates from GitHub releases (see updater.cjs).
 */
const { app, BrowserWindow, ipcMain, protocol, net, screen, shell, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const storage = require('./storage.cjs');
const inbox = require('./inbox.cjs');
const updater = require('./updater.cjs');
const config = require('./config.cjs');
const logs = require('./logs.cjs');
const menu = require('./menu.cjs');
const system = require('./system.cjs');
const lazer = require('./lazer.cjs');
const lazerWrite = require('./lazer-write.cjs');

logs.captureMain();

const DATA_DIR = storage.DATA_DIR;
fs.mkdirSync(DATA_DIR, { recursive: true });
// Before `ready`: the Chromium profile (localStorage, caches) lives in ~/.wosu too.
app.setPath('userData', path.join(DATA_DIR, '.electron'));
app.setName('wosu!');

// Rhythm game: render as fast as possible unless the player wants vsync
// (Settings → Graphics; applies on restart). Frame pacing is then up to
// the in-game frame limiter.
if (!config.get().vsync) {
    app.commandLine.appendSwitch('disable-frame-rate-limit');
    app.commandLine.appendSwitch('disable-gpu-vsync');
}
// Input and audio must not be throttled when the window is in the background or covered.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

protocol.registerSchemesAsPrivileged([{
    scheme: 'wosu',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

const DIST_DIR = path.join(__dirname, '..', 'dist');
const DEV_URL = process.env.WOSU_DEV_URL; // e.g. http://localhost:5173 for `npm run desktop:dev`

let win = null;

/** Saved bounds, if they still fit on a connected display. */
function savedBounds() {
    const w = config.get().window;
    if (!w) return { width: 1600, height: 900 };
    const visible = w.x !== null && w.y !== null && screen.getAllDisplays().some(d => {
        const a = d.workArea;
        return w.x < a.x + a.width - 100 && w.x + w.width > a.x + 100 && w.y >= a.y - 10 && w.y < a.y + a.height - 100;
    });
    return visible ? { x: w.x, y: w.y, width: w.width, height: w.height } : { width: w.width, height: w.height };
}

function trackBounds(w) {
    let timer = null;
    const save = () => {
        timer = null;
        if (w.isDestroyed() || w.isFullScreen() || w.isSimpleFullScreen() || w.isMinimized()) return;
        const maximized = w.isMaximized();
        // Maximized: keep the windowed size to come back to.
        const b = maximized ? (config.get().window ?? w.getNormalBounds()) : w.getBounds();
        config.set({ window: { ...b, maximized } });
    };
    const queue = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(save, 500);
    };
    for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) w.on(ev, queue);
    w.on('close', () => { if (timer) { clearTimeout(timer); save(); } });
}

function createWindow() {
    win = new BrowserWindow({
        ...savedBounds(),
        minWidth: 800,
        minHeight: 480,
        backgroundColor: '#000000',
        title: 'wosu!',
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            backgroundThrottling: false,
            autoplayPolicy: 'no-user-gesture-required',
            // WOSU_DEBUG=1: the page exposes `window.game` (profiling, scripted tests).
            additionalArguments: process.env.WOSU_DEBUG ? ['--wosu-debug'] : [],
        },
    });
    if (config.get().window?.maximized) win.maximize();
    trackBounds(win);
    win.once('ready-to-show', () => win.show());
    // External links (GitHub, beatmap pages) open in the system browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) void shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith('wosu://') && !(DEV_URL && url.startsWith(DEV_URL))) {
            e.preventDefault();
            if (/^https?:/.test(url)) void shell.openExternal(url);
        }
    });
    win.on('closed', () => { win = null; });
    win.once('ready-to-show', () => applyDisplayMode(config.get().displayMode));
    const onFullscreenEvent = () => {
        if (!win) return;
        if (transitioning || wantedMode) {
            // One of our own steps finished: take the next one.
            endTransition();
            return;
        }
        // The green button changed the mode from outside the game: tell it.
        const mode = currentMode();
        if (mode !== config.get().displayMode) config.set({ displayMode: mode });
        win.webContents.send('wosu:config-changed', config.get());
    };
    win.on('enter-full-screen', onFullscreenEvent);
    win.on('leave-full-screen', onFullscreenEvent);
    void win.loadURL(DEV_URL || 'wosu://app/index.html');
    updater.attach(win);
    inbox.attach(win);
    system.attach(win);
    logs.captureRenderer(win.webContents);
}

/*
 * Display mode changes run one step at a time. macOS fullscreen (its own
 * Space) animates in and out, and changing the window's style mask
 * (simple fullscreen) during that animation throws an NSException that
 * kills the app. So: leave native fullscreen, wait for the event, then
 * take the next step towards the wanted mode.
 */
let wantedMode = null;
let transitioning = false;
let transitionTimer = null;

function currentMode() {
    return win.isSimpleFullScreen() ? 'borderless' : win.isFullScreen() ? 'fullscreen' : 'windowed';
}

function applyDisplayMode(mode) {
    wantedMode = mode;
    stepDisplayMode();
}

function beginTransition() {
    transitioning = true;
    // Safety net: some cases (hidden window) never fire the events.
    clearTimeout(transitionTimer);
    transitionTimer = setTimeout(endTransition, 2000);
}

function endTransition() {
    clearTimeout(transitionTimer);
    transitioning = false;
    stepDisplayMode();
}

function stepDisplayMode() {
    if (!win || transitioning || !wantedMode) return;
    if (currentMode() === wantedMode) {
        wantedMode = null;
        return;
    }
    if (win.isFullScreen()) {
        beginTransition();
        win.setFullScreen(false); // continues on 'leave-full-screen'
        return;
    }
    if (win.isSimpleFullScreen()) win.setSimpleFullScreen(false);
    if (wantedMode === 'borderless') {
        win.setSimpleFullScreen(true);
    } else if (wantedMode === 'fullscreen') {
        beginTransition();
        win.setFullScreen(true); // continues on 'enter-full-screen'
        return;
    }
    wantedMode = null;
}

function registerConfigIpc() {
    ipcMain.on('wosu:config:get-sync', (e) => { e.returnValue = config.get(); });
    ipcMain.handle('wosu:config:set', (_e, patch) => {
        const prev = config.get();
        const next = config.set(patch);
        if (next.displayMode !== prev.displayMode) applyDisplayMode(next.displayMode);
        return next;
    });
    ipcMain.handle('wosu:relaunch', () => {
        app.relaunch();
        app.exit(0);
    });
}

function serveDist() {
    protocol.handle('wosu', (req) => {
        const { pathname } = new URL(req.url);
        const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
        const file = path.normalize(path.join(DIST_DIR, rel));
        if (!file.startsWith(DIST_DIR)) return new Response('Forbidden', { status: 403 });
        return net.fetch(pathToFileURL(file).toString());
    });
}

/**
 * Beatmap mirrors are built for browsers on their own sites; a few do not
 * send CORS headers for unknown origins. The desktop client is not a web
 * page, so allow cross-origin reads of every response.
 */
function relaxCors() {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
        const headers = details.responseHeaders ?? {};
        const has = Object.keys(headers).some(k => k.toLowerCase() === 'access-control-allow-origin');
        if (!has && /^https?:/.test(details.url)) headers['Access-Control-Allow-Origin'] = ['*'];
        cb({ responseHeaders: headers });
    });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.focus();
    });

    // Double-clicked / dragged-onto-dock .osz and .osk files: copy into the
    // matching folder; the watcher imports them.
    const pendingOpen = [];
    app.on('open-file', (e, file) => {
        e.preventDefault();
        if (app.isReady()) void inbox.adopt(file);
        else pendingOpen.push(file);
    });

    app.whenReady().then(() => {
        storage.registerIpc(ipcMain);
        void storage.migrateLegacy();
        inbox.registerIpc(ipcMain);
        updater.registerIpc(ipcMain);
        registerConfigIpc();
        system.registerIpc(ipcMain);
        lazer.registerIpc(ipcMain);
        lazerWrite.registerIpc(ipcMain);
        system.routeDownloads(session.defaultSession);
        menu.build(action => win?.webContents.send('wosu:menu', action));
        ipcMain.handle('wosu:open-data-dir', () => shell.openPath(DATA_DIR));
        serveDist();
        relaxCors();
        createWindow();
        for (const f of pendingOpen.splice(0)) void inbox.adopt(f);
        app.on('activate', () => { if (!win) createWindow(); });
    });

    app.on('window-all-closed', () => app.quit());
}

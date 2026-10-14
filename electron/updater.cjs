/**
 * One-click updates from GitHub releases.
 *
 * The app is not signed with an Apple Developer ID, so Squirrel.Mac
 * (electron-updater) cannot be used. Instead: download the release's
 * macOS .zip, unpack it with `ditto`, and let a tiny detached shell script
 * swap the .app bundle once this process has exited, then relaunch.
 *
 * The release repository is `wosuDesktop.updateRepo` in package.json.
 */
const { app, net } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { DATA_DIR } = require('./storage.cjs');

const pkg = require('../package.json');
const REPO = process.env.WOSU_UPDATE_REPO || pkg.wosuDesktop?.updateRepo || '';
const WORK_DIR = path.join(DATA_DIR, '.update');

let target = null;
let latest = null; // last check result with the asset to install
let installing = false;

function attach(win) {
    target = win;
}

function send(progress) {
    if (target && !target.isDestroyed()) target.webContents.send('wosu:update-progress', progress);
}

function parseVersion(v) {
    return String(v).replace(/^v/, '').split(/[.+-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
}

function newer(a, b) {
    const x = parseVersion(a), y = parseVersion(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
}

/** The running .app bundle (null when not packaged). */
function bundlePath() {
    if (!app.isPackaged) return null;
    // .../wosu!.app/Contents/MacOS/wosu!
    return path.resolve(path.dirname(process.execPath), '..', '..');
}

function pickAsset(assets) {
    const zips = assets.filter(a => /mac.*\.zip$|\.zip$/i.test(a.name) && !/blockmap/i.test(a.name));
    return zips.find(a => a.name.includes(process.arch))
        ?? zips.find(a => /universal/i.test(a.name))
        ?? (zips.length === 1 ? zips[0] : null);
}

async function check() {
    const current = app.getVersion();
    if (!REPO) return { current, available: false, error: 'No update repository configured' };
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'wosu-desktop' },
    });
    if (res.status === 404) return { current, available: false, error: 'No releases published yet' };
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    const rel = await res.json();
    const version = String(rel.tag_name || rel.name || '').replace(/^v/, '');
    const asset = pickAsset(rel.assets || []);
    const available = !!asset && newer(version, current);
    latest = available ? { version, asset } : null;
    return {
        current,
        latest: version,
        available,
        notes: rel.body ? String(rel.body).slice(0, 2000) : '',
        packaged: app.isPackaged,
        ...(!asset && newer(version, current) ? { error: 'The latest release has no macOS build' } : {}),
    };
}

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
    });
}

async function download(url, file) {
    const res = await net.fetch(url, { headers: { 'User-Agent': 'wosu-desktop', Accept: 'application/octet-stream' } });
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(file);
    const reader = res.body.getReader();
    let received = 0, lastSent = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (!out.write(value)) await new Promise(r => out.once('drain', r));
            const now = Date.now();
            if (now - lastSent > 100) {
                lastSent = now;
                send({ phase: 'download', received, total });
            }
        }
    } finally {
        await new Promise(r => out.end(r));
    }
    send({ phase: 'download', received, total: total || received });
}

async function findApp(dir) {
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
        if (ent.isDirectory() && ent.name.endsWith('.app')) return path.join(dir, ent.name);
    }
    return null;
}

const SWAP_SCRIPT = `#!/bin/bash
PID="$1"; NEW="$2"; DEST="$3"
for _ in $(seq 1 300); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done
rm -rf "$DEST.old"
if mv "$DEST" "$DEST.old" && mv "$NEW" "$DEST"; then
  rm -rf "$DEST.old"
else
  [ -d "$DEST" ] || mv "$DEST.old" "$DEST"
fi
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null
open "$DEST"
`;

async function install() {
    if (installing) throw new Error('An update is already being installed');
    const dest = bundlePath();
    if (!dest) throw new Error('Updates only work in the packaged app');
    if (dest.includes('/AppTranslocation/')) {
        throw new Error('Move wosu! to the Applications folder first (macOS runs it from a read-only copy)');
    }
    await fsp.access(path.dirname(dest), fs.constants.W_OK).catch(() => {
        throw new Error(`No permission to replace the app in ${path.dirname(dest)}`);
    });
    if (!latest) {
        const info = await check();
        if (!info.available) throw new Error(info.error || 'Already up to date');
    }
    installing = true;
    try {
        await fsp.rm(WORK_DIR, { recursive: true, force: true });
        await fsp.mkdir(WORK_DIR, { recursive: true });
        const zip = path.join(WORK_DIR, 'update.zip');
        await download(latest.asset.browser_download_url, zip);

        send({ phase: 'extract' });
        const unpacked = path.join(WORK_DIR, 'unpacked');
        await fsp.mkdir(unpacked);
        await run('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
        const newApp = await findApp(unpacked);
        if (!newApp) throw new Error('The update archive has no .app inside');
        await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', newApp]).catch(() => {});

        send({ phase: 'restart' });
        const script = path.join(WORK_DIR, 'swap.sh');
        await fsp.writeFile(script, SWAP_SCRIPT, { mode: 0o755 });
        spawn('/bin/bash', [script, String(process.pid), newApp, dest], { detached: true, stdio: 'ignore' }).unref();
        setTimeout(() => app.quit(), 300);
    } catch (e) {
        installing = false;
        throw e;
    }
}

function registerIpc(ipcMain) {
    ipcMain.handle('wosu:update:check', () => check());
    ipcMain.handle('wosu:update:install', () => install());
}

module.exports = { registerIpc, attach };

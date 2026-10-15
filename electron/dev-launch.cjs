/**
 * `npm run desktop` from source: starts Electron so the OS shows wosu!'s name and icon.
 *
 * macOS takes the Dock name and icon from the running bundle, which from source is
 * node_modules' Electron.app. The first start clones it (APFS clone: no extra disk) into
 * ~/.wosu/cache/wosu!-electron.app, renames it and gives it wosu!'s icon, re-signs it
 * ad hoc and runs that. Windows and Linux get the icon from the window (main.cjs).
 */
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'build', 'icon.png');
const electronBin = require('electron'); // path to the Electron executable

function run(exe) {
    const child = spawn(exe, [ROOT, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (process.platform !== 'darwin') {
    run(electronBin);
} else {
    let exe = electronBin;
    try {
        exe = ensureBundle();
    } catch (e) {
        console.warn('[desktop] could not rename Electron.app, starting it as is:', e.message);
    }
    run(exe);
}

function ensureBundle() {
    const source = path.resolve(path.dirname(electronBin), '..', '..'); // …/Electron.app
    const app = path.join(os.homedir(), '.wosu', 'cache', 'wosu!-electron.app');
    const exe = path.join(app, 'Contents', 'MacOS', path.basename(electronBin));
    const stamp = path.join(os.homedir(), '.wosu', 'cache', 'wosu!-electron.json');
    const version = fs.readFileSync(path.join(path.dirname(require.resolve('electron')), 'package.json'), 'utf8');
    const want = JSON.stringify({ source, version: JSON.parse(version).version, icon: fs.statSync(ICON).mtimeMs });
    if (fs.existsSync(exe) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === want) return exe;

    fs.rmSync(app, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(app), { recursive: true });
    execFileSync('/bin/cp', ['-c', '-R', source, app]); // APFS clone (falls back to a copy elsewhere)
    const plist = path.join(app, 'Contents', 'Info.plist');
    for (const [key, value] of [['CFBundleName', 'wosu!'], ['CFBundleDisplayName', 'wosu!'], ['CFBundleIconFile', 'wosu.icns']]) {
        execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, plist]);
    }
    makeIcns(ICON, path.join(app, 'Contents', 'Resources', 'wosu.icns'));
    // The edited Info.plist breaks Electron's signature: sign the copy ad hoc for this Mac.
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' });
    fs.writeFileSync(stamp, want);
    return exe;
}

/** build/icon.png → .icns with macOS's own sips + iconutil. */
function makeIcns(png, out) {
    const set = path.join(os.tmpdir(), `wosu-${process.pid}.iconset`);
    fs.rmSync(set, { recursive: true, force: true });
    fs.mkdirSync(set);
    for (const size of [16, 32, 128, 256, 512]) {
        for (const scale of [1, 2]) {
            const px = size * scale;
            execFileSync('/usr/bin/sips', ['-z', String(px), String(px), png, '--out', path.join(set, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'ignore' });
        }
    }
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', set, '-o', out], { stdio: 'ignore' });
    fs.rmSync(set, { recursive: true, force: true });
}

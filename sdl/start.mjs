/**
 * `npm start`: runs host.mjs so the OS shows wosu!'s name and icon, not node's.
 *
 * macOS takes an app's Dock name and icon from the bundle its executable lives
 * in, so the first start writes a small wosu!.app into ~/.wosu/cache (Info.plist,
 * the icon, and a hard link to this node binary) and re-runs the host through it.
 * Windows and Linux get the icon from the window itself (host.mjs sets it).
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = path.join(HERE, 'host.mjs');
const ICON = path.join(HERE, '..', 'build', 'icon.png');

if (process.platform === 'darwin' && !process.env.WOSU_APP_BUNDLE) {
    let exe = null;
    try {
        exe = ensureBundle();
    } catch (e) {
        console.warn('[start] app bundle unavailable, running as node:', e.message);
    }
    if (exe) {
        const child = spawn(exe, [...process.execArgv, HOST, ...process.argv.slice(2)], {
            stdio: 'inherit',
            env: { ...process.env, WOSU_APP_BUNDLE: '1' },
        });
        for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
        child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    } else {
        await import('./host.mjs');
    }
} else {
    await import('./host.mjs');
}

/** ~/.wosu/cache/wosu!.app around this node binary; returns its executable. */
function ensureBundle() {
    const app = path.join(os.homedir(), '.wosu', 'cache', 'wosu!.app');
    const macos = path.join(app, 'Contents', 'MacOS');
    const resources = path.join(app, 'Contents', 'Resources');
    const exe = path.join(macos, 'wosu!');
    const node = fs.realpathSync(process.execPath);
    const nodeStat = fs.statSync(node);
    const stamp = path.join(app, 'Contents', 'source.json');
    const want = JSON.stringify({ node, ino: nodeStat.ino, mtime: nodeStat.mtimeMs, icon: fs.statSync(ICON).mtimeMs });
    if (fs.existsSync(exe) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === want) return exe;

    fs.rmSync(app, { recursive: true, force: true });
    fs.mkdirSync(macos, { recursive: true });
    fs.mkdirSync(resources, { recursive: true });
    // Hard links cost nothing; copies if node lives on another volume.
    const link = (from, to) => {
        try {
            fs.linkSync(from, to);
        } catch {
            fs.copyFileSync(from, to);
            fs.chmodSync(to, 0o755);
        }
    };
    link(node, exe);
    // Homebrew's node is a stub that loads @rpath/libnode.*.dylib from ../lib.
    const libDir = path.join(path.dirname(node), '..', 'lib');
    const libs = fs.existsSync(libDir) ? fs.readdirSync(libDir).filter(n => /^libnode\..*dylib$/.test(n)) : [];
    if (libs.length) {
        fs.mkdirSync(path.join(app, 'Contents', 'lib'), { recursive: true });
        for (const n of libs) link(fs.realpathSync(path.join(libDir, n)), path.join(app, 'Contents', 'lib', n));
    }
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>wosu!</string>
    <key>CFBundleDisplayName</key><string>wosu!</string>
    <key>CFBundleIdentifier</key><string>dev.underweek.wosu.sdl</string>
    <key>CFBundleExecutable</key><string>wosu!</string>
    <key>CFBundleIconFile</key><string>icon</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
`);
    makeIcns(ICON, path.join(resources, 'icon.icns'));
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
            const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
            execFileSync('/usr/bin/sips', ['-z', String(px), String(px), png, '--out', path.join(set, name)], { stdio: 'ignore' });
        }
    }
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', set, '-o', out], { stdio: 'ignore' });
    fs.rmSync(set, { recursive: true, force: true });
}

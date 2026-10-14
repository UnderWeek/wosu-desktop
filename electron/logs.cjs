/**
 * Log files in ~/.wosu/logs: the main process, the game's console
 * (warnings and errors) and crashes. One file per day, a week kept.
 */
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { app } = require('electron');
const { DATA_DIR } = require('./storage.cjs');

const LOG_DIR = path.join(DATA_DIR, 'logs');
const KEEP_DAYS = 7;

fs.mkdirSync(LOG_DIR, { recursive: true });

function today() {
    return new Date().toISOString().slice(0, 10);
}

let day = '';
let stream = null;
function out() {
    const d = today();
    if (d !== day || !stream) {
        stream?.end();
        day = d;
        stream = fs.createWriteStream(path.join(LOG_DIR, `wosu-${d}.log`), { flags: 'a' });
    }
    return stream;
}

function write(source, level, message) {
    const time = new Date().toISOString().slice(11, 23);
    out().write(`${time} [${source}] ${level.toUpperCase()}: ${message}\n`);
}

function prune() {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
    for (const name of fs.readdirSync(LOG_DIR)) {
        const full = path.join(LOG_DIR, name);
        try {
            if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full);
        } catch { /* ignore */ }
    }
}

/** Mirror main-process console output into the log file. */
function captureMain() {
    for (const level of ['log', 'info', 'warn', 'error']) {
        const orig = console[level].bind(console);
        console[level] = (...args) => {
            orig(...args);
            write('main', level, util.format(...args));
        };
    }
    process.on('uncaughtException', e => write('main', 'error', `uncaught: ${e.stack || e}`));
    process.on('unhandledRejection', e => write('main', 'error', `unhandled rejection: ${e?.stack || e}`));
    app.on('child-process-gone', (_e, d) => write('main', 'error', `${d.type} process gone: ${d.reason} (exit ${d.exitCode})`));
}

/** The game's console: warnings and errors (logs too when WOSU_LOG_ALL is set). */
function captureRenderer(webContents) {
    const all = !!process.env.WOSU_LOG_ALL;
    webContents.on('console-message', (e) => {
        const level = e.level; // 'info' | 'warning' | 'error' | 'debug'
        // The audio and input debuggers' lines are always kept (src/debug/).
        const audio = typeof e.message === 'string' && /^\[(audio|input)\]/.test(e.message);
        if (!all && !audio && level !== 'warning' && level !== 'error') return;
        const where = e.sourceId ? ` (${path.basename(e.sourceId)}:${e.lineNumber})` : '';
        write('game', level, `${e.message}${where}`);
    });
    webContents.on('render-process-gone', (_e, d) => write('game', 'error', `renderer gone: ${d.reason} (exit ${d.exitCode})`));
    webContents.on('unresponsive', () => write('game', 'warning', 'renderer unresponsive'));
}

prune();
write('main', 'info', `wosu! ${app.getVersion()} starting (Electron ${process.versions.electron}, ${process.platform} ${process.arch})`);

module.exports = { LOG_DIR, captureMain, captureRenderer, write };

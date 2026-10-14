/**
 * Desktop-only preferences that must be known before the renderer starts
 * (Chromium switches) or that belong to the window: ~/.wosu/desktop.json.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./storage.cjs');

const FILE = path.join(DATA_DIR, 'desktop.json');
const DISPLAY_MODES = ['windowed', 'fullscreen', 'borderless'];

const DEFAULTS = {
    /** false: Chromium renders uncapped (no vsync); the in-game frame limiter still applies. */
    vsync: false,
    /** windowed | fullscreen (macOS Space) | borderless (instant, stays on this desktop). */
    displayMode: 'windowed',
    /** false: render at 1 pixel per point on Retina screens (like osu!lazer), upscaled by macOS. */
    hidpi: false,
    /** Read osu!lazer's beatmaps and skins in place (when it is installed). */
    lazer: true,
    /** Where new beatmaps, skins, scores and collections go: 'wosu' (~/.wosu) or 'lazer' (its library). */
    storage: 'wosu',
    /** Last windowed bounds and whether it was maximized (restored at launch). */
    window: null,
};

function sanitizeWindow(w) {
    if (!w || typeof w !== 'object') return null;
    const n = v => (Number.isFinite(v) ? Math.round(v) : null);
    const b = { x: n(w.x), y: n(w.y), width: n(w.width), height: n(w.height), maximized: !!w.maximized };
    return b.width && b.height ? b : null;
}

function sanitize(c) {
    return {
        vsync: typeof c.vsync === 'boolean' ? c.vsync : DEFAULTS.vsync,
        displayMode: DISPLAY_MODES.includes(c.displayMode) ? c.displayMode : DEFAULTS.displayMode,
        hidpi: typeof c.hidpi === 'boolean' ? c.hidpi : DEFAULTS.hidpi,
        lazer: typeof c.lazer === 'boolean' ? c.lazer : DEFAULTS.lazer,
        storage: c.storage === 'lazer' ? 'lazer' : 'wosu',
        window: sanitizeWindow(c.window),
    };
}

let config = DEFAULTS;
try {
    config = sanitize(JSON.parse(fs.readFileSync(FILE, 'utf8')));
} catch {
    config = { ...DEFAULTS };
}

function get() {
    return config;
}

function set(patch) {
    config = sanitize({ ...config, ...patch });
    try {
        fs.writeFileSync(FILE, JSON.stringify(config, null, 2));
    } catch (e) {
        console.warn('[config] save failed', e);
    }
    return config;
}

module.exports = { get, set };

/**
 * The slice of @kmamal/sdl that sdl/host.mjs uses, on Android: one
 * fullscreen window backed by the NativeActivity's ANativeWindow, with
 * events from libwosu.so's bridge (android/native/main.cpp).
 *
 * Extra events beyond SDL's: 'touch' (multi-touch with exact timestamps),
 * 'surfaceLost' / 'surfaceRestored' (app backgrounded / foregrounded).
 */
import { EventEmitter } from 'node:events';

const mod = { exports: {} };
process.dlopen(mod, `${process.env.WOSU_LIB_DIR}/libwosu.so`);
export const bridge = mod.exports;

/** CSS pixels per window pixel. The game fits its UI to the height either way. */
const DPR = Number(process.env.WOSU_DPR) || 2;

// Bridge event types (main.cpp).
const EV = { WINDOW: 1, WINDOW_LOST: 2, RESIZE: 3, TOUCH: 4, KEY: 5, FOCUS: 6, PAUSE: 7, RESUME: 8 };
const TOUCH_ACTIONS = ['down', 'move', 'up', 'cancel'];

/** SDL scancodes (the subset host.mjs maps to KeyboardEvent.code). */
const SCANCODE = {
    RETURN: 40, ESCAPE: 41, BACKSPACE: 42, TAB: 43, SPACE: 44, MINUS: 45, EQUALS: 46, LEFTBRACKET: 47, RIGHTBRACKET: 48,
    BACKSLASH: 49, SEMICOLON: 51, APOSTROPHE: 52, GRAVE: 53, COMMA: 54, PERIOD: 55, SLASH: 56, CAPSLOCK: 57, DELETE: 76,
    HOME: 74, PAGEUP: 75, END: 77, PAGEDOWN: 78, RIGHT: 79, LEFT: 80, DOWN: 81, UP: 82,
    LCTRL: 224, LSHIFT: 225, LALT: 226, LGUI: 227, RCTRL: 228, RSHIFT: 229, RALT: 230, RGUI: 231,
};
for (let i = 0; i < 26; i++) SCANCODE[String.fromCharCode(65 + i)] = 4 + i;
for (let i = 1; i <= 9; i++) SCANCODE[String(i)] = 29 + i;
SCANCODE['0'] = 39;
for (let i = 1; i <= 12; i++) SCANCODE[`F${i}`] = 57 + i;

/** Android keycode → [SDL scancode name, SDL key name, shifted char]. */
const KEYS = {
    4: ['ESCAPE', 'escape'], // Back button / gesture: osu!'s "back"
    111: ['ESCAPE', 'escape'], 66: ['RETURN', 'return'], 160: ['RETURN', 'return'], 67: ['BACKSPACE', 'backspace'],
    112: ['DELETE', 'delete'], 61: ['TAB', 'tab'], 62: ['SPACE', ' '], 19: ['UP', 'up'], 20: ['DOWN', 'down'],
    21: ['LEFT', 'left'], 22: ['RIGHT', 'right'], 122: ['HOME', 'home'], 123: ['END', 'end'], 92: ['PAGEUP', 'pageUp'],
    93: ['PAGEDOWN', 'pageDown'], 59: ['LSHIFT', 'shift'], 60: ['RSHIFT', 'shift'], 113: ['LCTRL', 'ctrl'],
    114: ['RCTRL', 'ctrl'], 57: ['LALT', 'alt'], 58: ['RALT', 'alt'], 117: ['LGUI', 'gui'], 118: ['RGUI', 'gui'],
    115: ['CAPSLOCK', 'capsLock'], 68: ['GRAVE', '`', '~'], 69: ['MINUS', '-', '_'], 70: ['EQUALS', '=', '+'],
    71: ['LEFTBRACKET', '[', '{'], 72: ['RIGHTBRACKET', ']', '}'], 73: ['BACKSLASH', '\\', '|'],
    74: ['SEMICOLON', ';', ':'], 75: ['APOSTROPHE', "'", '"'], 55: ['COMMA', ',', '<'], 56: ['PERIOD', '.', '>'],
    76: ['SLASH', '/', '?'],
};
for (let i = 0; i < 26; i++) KEYS[29 + i] = [String.fromCharCode(65 + i), String.fromCharCode(97 + i), String.fromCharCode(65 + i)];
const SHIFTED_DIGITS = ')!@#$%^&*(';
for (let i = 0; i <= 9; i++) KEYS[7 + i] = [String(i), String(i), SHIFTED_DIGITS[i]];
for (let i = 1; i <= 12; i++) KEYS[130 + i] = [`F${i}`, `f${i}`];

const META = { SHIFT: 0x1, ALT: 0x2, CTRL: 0x1000, META: 0x10000 };

class AndroidWindow extends EventEmitter {
    constructor(w) {
        super();
        this.destroyed = false;
        this.visible = true;
        this.fullscreen = true;
        this._native = { gpu: w.gpu };
        this._setSize(w.width, w.height);
    }
    _setSize(pw, ph) {
        this._pixelWidth = pw;
        this._pixelHeight = ph;
        this.pixelWidth = pw;
        this.pixelHeight = ph;
        this.width = Math.round(pw / DPR);
        this.height = Math.round(ph / DPR);
    }
    focus() {}
    setTitle() {}
    setFullscreen() {}
}

let win = null;
/** Bridge times (CLOCK_MONOTONIC ms) → performance.now() timebase. */
let clockOffset = performance.now() - bridge.now();

function pump() {
    const ev = bridge.poll();
    if (ev.length === 0) return;
    clockOffset = performance.now() - bridge.now();
    for (let i = 0; i < ev.length; i += 7) {
        const type = ev[i], action = ev[i + 1], id = ev[i + 2], x = ev[i + 3], y = ev[i + 4], time = ev[i + 5], meta = ev[i + 6];
        switch (type) {
            case EV.WINDOW: {
                const w = bridge.window();
                if (!w) break;
                win._native.gpu = w.gpu;
                win._setSize(w.width, w.height);
                win.visible = true;
                win.emit('surfaceRestored');
                win.emit('resize');
                break;
            }
            case EV.WINDOW_LOST:
                win.visible = false;
                win.emit('surfaceLost');
                bridge.ackWindowLost();
                break;
            case EV.RESIZE:
                win._setSize(x, y);
                win.emit('resize');
                break;
            case EV.TOUCH:
                win.emit('touch', { action: TOUCH_ACTIONS[action], id, x: x / DPR, y: y / DPR, time: time + clockOffset, toolType: meta });
                break;
            case EV.KEY: {
                const k = KEYS[id];
                if (!k) break;
                const shift = !!(meta & META.SHIFT);
                const e = {
                    scancode: SCANCODE[k[0]], key: k[1], shift, alt: !!(meta & META.ALT), ctrl: !!(meta & META.CTRL),
                    super: !!(meta & META.META), repeat: false,
                };
                win.emit(action === 0 ? 'keyDown' : 'keyUp', e);
                const ch = shift ? k[2] : k[1];
                if (action === 0 && ch && ch.length === 1 && !e.ctrl && !e.alt) win.emit('textInput', { text: ch });
                break;
            }
            case EV.FOCUS:
                win.emit(action ? 'focus' : 'blur');
                break;
            case EV.PAUSE:
                win.visible = false;
                win.emit('blur');
                break;
            case EV.RESUME:
                win.visible = true;
                break;
        }
    }
}

/** The activity's window arrives a moment after start: wait for it. */
async function firstWindow() {
    for (;;) {
        const ev = bridge.poll();
        for (let i = 0; i < ev.length; i += 7) {
            if (ev[i] === EV.WINDOW) {
                const w = bridge.window();
                if (w) return w;
            }
        }
        await new Promise(r => setTimeout(r, 5));
    }
}
const first = await firstWindow();

export default {
    video: {
        createWindow() {
            win = new AndroidWindow(first);
            return win;
        },
    },
    mouse: { showCursor() {} },
    keyboard: { SCANCODE },
    /** Called by the host at the start of every frame. */
    pump,
    bridge,
};

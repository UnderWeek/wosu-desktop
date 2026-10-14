/**
 * wosu! without a browser engine: a Node host that gives the built game
 * (../dist) what it expects from a browser, backed by native pieces:
 *   window + input  → SDL2 (@kmamal/sdl)
 *   WebGPU          → Dawn (@kmamal/gpu), presented straight into the SDL window
 *   2D canvas/text  → Skia (@napi-rs/canvas)
 *   DOM             → happy-dom (the few elements the game touches)
 *   Web Audio       → node-web-audio-api
 *
 * Step 1 of the port: does the game boot and render, and how fast.
 * Env: PRESENT=immediate|mailbox|fifo (default immediate), STATS=1 prints fps.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sdl from '@kmamal/sdl';
import gpu from '@kmamal/gpu';
import { Window as HappyWindow } from 'happy-dom';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import * as webAudio from 'node-web-audio-api';
import { createNative } from './native.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');
const ORIGIN = 'wosu://app/';
const PRESENT = process.env.PRESENT || 'immediate';

// ---------------------------------------------------------------------------
// Window + GPU
// ---------------------------------------------------------------------------

const win = sdl.video.createWindow({ title: 'wosu! (sdl)', width: 1280, height: 720, resizable: true, webgpu: true });
win.focus();
const instance = gpu.create([]);
/** Bound to the game's own device when it configures the canvas (see GPUCanvasContextShim). */
let renderer = null;

/** Dawn in Node can't take browser image objects: upload pixels ourselves. */
/** Debug (KEEP=…): hold GPU objects so their finalizers never run (finds over-release bugs). */
const keepAlive = [];
const KEEP = new Set((process.env.KEEP ?? '').split(',').filter(Boolean));
function keepObjects(device) {
    if (!KEEP.size) return;
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(device))) {
        if (!name.startsWith('create') || typeof device[name] !== 'function') continue;
        const kind = name.slice(6);
        if (!KEEP.has('all') && !KEEP.has(kind)) continue;
        const orig = device[name].bind(device);
        device[name] = (...a) => {
            const r = orig(...a);
            if (r && typeof r.then === 'function') r.then(x => keepAlive.push(x));
            else keepAlive.push(r);
            // KEEP_RING=n: hold only the newest n (tests whether a short window is enough).
            const ring = Number(process.env.KEEP_RING || 0);
            if (ring && keepAlive.length > ring) keepAlive.splice(0, keepAlive.length - ring);
            if (kind === 'Texture' && (KEEP.has('all') || KEEP.has('TextureView'))) {
                const cv = r.createView.bind(r);
                r.createView = (...b) => { const v = cv(...b); keepAlive.push(v); return v; };
            }
            return r;
        };
    }
}

/**
 * ENC=unfinished: hold command encoders only until finish() (tests whether
 * collecting never-finished encoders is what trips Dawn's refcount assert).
 */
const liveEncoders = new Set();
const encStats = { created: 0, finished: 0 };
function trackEncoders(device) {
    if (process.env.ENC !== 'unfinished') return;
    const orig = device.createCommandEncoder.bind(device);
    device.createCommandEncoder = (...a) => {
        const enc = orig(...a);
        encStats.created++;
        liveEncoders.add(enc);
        const fin = enc.finish.bind(enc);
        enc.finish = (...b) => {
            encStats.finished++;
            liveEncoders.delete(enc);
            return fin(...b);
        };
        return enc;
    };
    setInterval(() => console.log(`[enc] created ${encStats.created} finished ${encStats.finished} unfinished-held ${liveEncoders.size}`), 2000).unref();
}

function patchQueue(device) {
    if (device.queue.__patched) return;
    device.queue.__patched = true;
    keepObjects(device);
    trackEncoders(device);
    const origCopy = device.queue.copyExternalImageToTexture?.bind(device.queue);
    device.queue.copyExternalImageToTexture = (source, destination, size) => {
    const src = source.source;
    const px = pixelsOf(src);
    if (!px) return origCopy?.(source, destination, size);
    const w = Array.isArray(size) ? size[0] : size.width;
    const h = Array.isArray(size) ? size[1] : size.height;
    let data = px.data;
    if (destination.premultipliedAlpha) data = premultiply(data);
    device.queue.writeTexture(
        { texture: destination.texture, mipLevel: destination.mipLevel ?? 0, origin: destination.origin ?? [0, 0, 0] },
        data,
        { bytesPerRow: px.width * 4, rowsPerImage: px.height },
        [w, h, 1],
    );
    };
}

function premultiply(src) {
    const out = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i += 4) {
        const a = src[i + 3];
        out[i] = (src[i] * a + 127) / 255;
        out[i + 1] = (src[i + 1] * a + 127) / 255;
        out[i + 2] = (src[i + 2] * a + 127) / 255;
        out[i + 3] = a;
    }
    return out;
}

/** RGBA pixels of an image-like source (our bitmaps, Skia canvases). */
function pixelsOf(src) {
    if (!src) return null;
    if (src.__rgba) return { data: src.__rgba, width: src.width, height: src.height };
    const skia = src.__skia ?? (typeof src.getContext === 'function' && src.data ? src : null);
    if (skia) {
        const ctx = skia.getContext('2d');
        const img = ctx.getImageData(0, 0, skia.width, skia.height);
        return { data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength), width: skia.width, height: skia.height };
    }
    return null;
}

// ---------------------------------------------------------------------------
// Browser-like globals
// ---------------------------------------------------------------------------

const hw = new HappyWindow({ url: ORIGIN, width: win.width, height: win.height });
const doc = hw.document;
doc.body.innerHTML = '<div id="app"></div>';

const g = globalThis;
for (const name of ['window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
    'HTMLElement', 'HTMLCanvasElement', 'HTMLImageElement', 'HTMLAudioElement', 'HTMLVideoElement', 'HTMLMediaElement', 'Element', 'Node',
    'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'WheelEvent', 'FocusEvent', 'UIEvent', 'CustomEvent',
    'getComputedStyle', 'matchMedia', 'DOMParser', 'MutationObserver', 'ResizeObserver', 'XMLSerializer', 'Image']) {
    try {
        Object.defineProperty(g, name, { value: hw[name], configurable: true, writable: true });
    } catch { /* keep Node's */ }
}
g.window = g;
// The game reads window.* and document.*; route window events through one target.
for (const k of ['addEventListener', 'removeEventListener', 'dispatchEvent']) g[k] = hw[k].bind(hw);
Object.defineProperty(g, 'devicePixelRatio', { get: () => win.pixelWidth / win.width, configurable: true });
Object.defineProperty(g, 'innerWidth', { get: () => win.width, configurable: true });
Object.defineProperty(g, 'innerHeight', { get: () => win.height, configurable: true });
g.screen = { width: win.width, height: win.height, availWidth: win.width, availHeight: win.height };
g.visualViewport = null;
g.isSecureContext = true;
g.location = hw.location;
g.navigator = hw.navigator;
Object.defineProperty(g.navigator, 'gpu', { value: Object.assign(instance, { getPreferredCanvasFormat: () => 'bgra8unorm' }), configurable: true });

// WebGPU's global enums and classes (Pixi uses GPUTextureUsage.* etc. and instanceof checks).
for (const [k, v] of Object.entries(gpu)) if (k.startsWith('GPU') || k === 'WGSLLanguageFeatures') g[k] ??= v;

// Pixi probes image decoding in a Worker; answer "not supported" so it decodes here (createImageBitmap below).
g.Worker = class WorkerShim extends EventTarget {
    constructor() {
        super();
        setTimeout(() => {
            const ev = new Event('message');
            ev.data = false;
            this.dispatchEvent(ev);
            this.onmessage?.(ev);
        });
    }
    postMessage() {}
    terminate() {}
};

// Web Audio
for (const [k, v] of Object.entries(webAudio)) if (!(k in g)) g[k] = v;
g.webkitAudioContext = g.AudioContext;

// ---------------------------------------------------------------------------
// Canvas: 'webgpu' → the SDL window, '2d' → Skia
// ---------------------------------------------------------------------------

let mainContext = null;
/** Only present frames the game actually drew into (Dawn rejects presenting an untouched surface). */
let textureTaken = false;
const SURFACE_FORMAT = 'bgra8unorm';

/**
 * The game's 'webgpu' canvas. Pixi renders into a real texture the size of
 * the canvas (logical size × the game's resolution: 1× unless Retina is on);
 * at the end of each frame the host draws it scaled onto the window surface.
 * That keeps the game's resolution independent of the window's pixel density
 * and avoids renderer.getCurrentTexture(), which over-releases the device.
 */
const BLIT_WGSL = `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
    var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    var o: V;
    o.pos = vec4f(p[i], 0.0, 1.0);
    o.uv = vec2f((p[i].x + 1.0) * 0.5, (1.0 - p[i].y) * 0.5);
    return o;
}
@fragment fn fs(v: V) -> @location(0) vec4f { return textureSample(src, smp, v.uv); }`;

class GPUCanvasContextShim {
    constructor(canvas) {
        this.canvas = canvas;
        this.texture = null;
        this.bindGroup = null;
    }
    configure(cfg) {
        this.cfg = cfg;
        if (this.device !== cfg.device) {
            this.device = cfg.device;
            patchQueue(cfg.device);
            renderer = gpu.renderGPUDeviceToWindow({ device: cfg.device, window: win, presentMode: PRESENT });
            const module = cfg.device.createShaderModule({ code: BLIT_WGSL });
            this.pipeline = cfg.device.createRenderPipeline({
                layout: 'auto',
                vertex: { module, entryPoint: 'vs' },
                fragment: { module, entryPoint: 'fs', targets: [{ format: SURFACE_FORMAT }] },
                primitive: { topology: 'triangle-list' },
            });
            this.sampler = cfg.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
            this.texture = null;
        }
    }
    unconfigure() {}
    getConfiguration() {
        return this.cfg ?? null;
    }
    getCurrentTexture() {
        const w = Math.max(1, this.canvas.width), h = Math.max(1, this.canvas.height);
        if (!this.texture || this.texture.width !== w || this.texture.height !== h) {
            this.texture?.destroy();
            this.texture = this.device.createTexture({
                label: 'canvas',
                size: [w, h, 1],
                format: this.cfg.format,
                usage: gpu.GPUTextureUsage.RENDER_ATTACHMENT | gpu.GPUTextureUsage.TEXTURE_BINDING | gpu.GPUTextureUsage.COPY_SRC | gpu.GPUTextureUsage.COPY_DST,
            });
            this.bindGroup = this.device.createBindGroup({
                layout: this.pipeline.getBindGroupLayout(0),
                entries: [{ binding: 0, resource: this.texture.createView() }, { binding: 1, resource: this.sampler }],
            });
        }
        textureTaken = true;
        return this.texture;
    }
    /** Draw this frame's canvas onto the window and show it. */
    present() {
        if (!this.texture) return;
        const enc = this.device.createCommandEncoder();
        const pass = enc.beginRenderPass({
            colorAttachments: [{ view: renderer.getCurrentTextureView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
        });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup);
        pass.draw(3);
        pass.end();
        this.device.queue.submit([enc.finish()]);
        renderer.swap();
    }
}

const createElement = doc.createElement.bind(doc);
doc.createElement = (tag, opts) => {
    const el = createElement(tag, opts);
    if (String(tag).toLowerCase() !== 'canvas') return el;
    let skia = null;
    let w = 300, h = 150;
    const ensure = () => {
        if (!skia || skia.width !== w || skia.height !== h) skia = createCanvas(Math.max(1, w), Math.max(1, h));
        return skia;
    };
    Object.defineProperty(el, 'width', { get: () => w, set: v => { w = Math.max(0, v | 0); if (skia) ensure(); }, configurable: true });
    Object.defineProperty(el, 'height', { get: () => h, set: v => { h = Math.max(0, v | 0); if (skia) ensure(); }, configurable: true });
    Object.defineProperty(el, '__skia', { get: () => ensure(), configurable: true });
    el.getContext = (type) => {
        if (type === 'webgpu') {
            mainContext ??= new GPUCanvasContextShim(el);
            return mainContext;
        }
        if (type === '2d') {
            const ctx = ensure().getContext('2d');
            ctx.canvas ??= el;
            return ctx;
        }
        return null;
    };
    el.toBlob = (cb, type = 'image/png') => cb(new Blob([ensure().toBuffer(type === 'image/jpeg' ? 'image/jpeg' : 'image/png')], { type }));
    el.toDataURL = (type) => ensure().toDataURL(type);
    el.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: w, height: h, right: w, bottom: h });
    return el;
};

class OffscreenCanvasShim {
    constructor(w, h) {
        this.width = w;
        this.height = h;
        this.__skiaCanvas = createCanvas(Math.max(1, w), Math.max(1, h));
    }
    get __skia() {
        if (this.__skiaCanvas.width !== this.width || this.__skiaCanvas.height !== this.height) this.__skiaCanvas = createCanvas(Math.max(1, this.width), Math.max(1, this.height));
        return this.__skiaCanvas;
    }
    getContext(type) {
        return type === '2d' ? this.__skia.getContext('2d') : null;
    }
    async convertToBlob(opts = {}) {
        const type = opts.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
        return new Blob([this.__skia.toBuffer(type)], { type });
    }
}
g.OffscreenCanvas = OffscreenCanvasShim;

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/** An ImageBitmap stand-in: decoded RGBA plus a Skia image for drawImage. */
async function bitmapFrom(source) {
    let img;
    if (source instanceof Blob) img = await loadImage(Buffer.from(await source.arrayBuffer()));
    else if (source?.__skia) img = source.__skia;
    else if (source?.__image) img = source.__image;
    else img = await loadImage(source);
    const c = createCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    return { width: img.width, height: img.height, __rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), __image: c, close() {} };
}
g.createImageBitmap = (source, ...rest) => {
    if (typeof rest[0] === 'object' || rest.length > 3) {
        // createImageBitmap(src, options): resize options are only used for big backgrounds.
        return bitmapFrom(source);
    }
    return bitmapFrom(source);
};
g.ImageBitmap = Object;

// Canvas 2D drawImage must accept our bitmaps and canvases.
const proto2d = Object.getPrototypeOf(createCanvas(1, 1).getContext('2d'));
g.CanvasRenderingContext2D = proto2d.constructor;
const drawImage = proto2d.drawImage;
proto2d.drawImage = function (src, ...a) {
    return drawImage.call(this, src?.__image ?? src?.__skia ?? src, ...a);
};

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

class FontFaceShim {
    constructor(family, source, descriptors = {}) {
        this.family = family;
        this.source = source;
        this.descriptors = descriptors;
        this.status = 'unloaded';
    }
    async load() {
        const m = /url\(["']?([^"')]+)["']?\)/.exec(String(this.source));
        if (m) {
            const res = await g.fetch(m[1]);
            GlobalFonts.register(Buffer.from(await res.arrayBuffer()), this.family);
        }
        this.status = 'loaded';
        return this;
    }
}
g.FontFace = FontFaceShim;
const fontSet = new Set();
Object.defineProperty(doc, 'fonts', { value: { add: f => fontSet.add(f), delete: f => fontSet.delete(f), ready: Promise.resolve(), check: () => true, load: async () => [], forEach: fn => fontSet.forEach(fn), status: 'loaded' }, configurable: true });

// ---------------------------------------------------------------------------
// fetch: the game's own files from ../dist, the rest from the network
// ---------------------------------------------------------------------------

const nodeFetch = globalThis.fetch.bind(globalThis);
const MIME = { '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.ttf': 'font/ttf', '.fnt': 'text/plain', '.woff2': 'font/woff2', '.ini': 'text/plain' };
g.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input), ORIGIN);
    if (url.protocol === 'wosu:') {
        const file = path.join(DIST, decodeURIComponent(url.pathname));
        try {
            const body = await fs.promises.readFile(file);
            return new Response(body, { status: 200, headers: { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' } });
        } catch {
            return new Response('not found', { status: 404 });
        }
    }
    if (url.protocol === 'file:') {
        try {
            const file = fileURLToPath(url);
            return new Response(await fs.promises.readFile(file), { status: 200, headers: { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' } });
        } catch {
            return new Response('not found', { status: 404 });
        }
    }
    if (url.protocol === 'blob:') return nodeFetch(input, init);
    return nodeFetch(url, init);
};

// ---------------------------------------------------------------------------
// Frame loop (requestAnimationFrame) and presentation
// ---------------------------------------------------------------------------

let rafId = 0;
let rafQueue = new Map();
g.requestAnimationFrame = cb => {
    rafQueue.set(++rafId, cb);
    return rafId;
};
g.cancelAnimationFrame = id => rafQueue.delete(id);

const stats = { frames: 0, worst: 0, since: performance.now() };
function frame() {
    if (win.destroyed) return;
    const t = performance.now();
    const q = rafQueue;
    rafQueue = new Map();
    for (const cb of q.values()) {
        try {
            cb(t);
        } catch (e) {
            console.error('[raf]', e);
        }
    }
    // Pixi submitted this frame's work into renderer.getCurrentTexture(): show it.
    const drew = textureTaken && renderer;
    if (drew) {
        mainContext.present();
        textureTaken = false;
    }
    const d = performance.now() - t;
    if (drew) {
        stats.frames++;
        if (d > stats.worst) stats.worst = d;
    }
    if (t - stats.since >= 1000) {
        if (process.env.STATS) console.log(`[sdl] ${stats.frames} fps, worst frame ${stats.worst.toFixed(1)} ms (${PRESENT})`);
        win.setTitle(`wosu! (sdl) — ${stats.frames} fps`);
        stats.frames = 0;
        stats.worst = 0;
        stats.since = t;
    }
    setImmediate(frame);
}

// ---------------------------------------------------------------------------
// Input: SDL events → DOM events (window for the game, the canvas for Pixi)
// ---------------------------------------------------------------------------

const CODES = { escape: 'Escape', return: 'Enter', space: 'Space', backspace: 'Backspace', tab: 'Tab', grave: 'Backquote', backquote: 'Backquote',
    left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', leftShift: 'ShiftLeft', rightShift: 'ShiftRight',
    leftCtrl: 'ControlLeft', rightCtrl: 'ControlRight', leftAlt: 'AltLeft', rightAlt: 'AltRight', leftGui: 'MetaLeft', rightGui: 'MetaRight',
    delete: 'Delete', home: 'Home', end: 'End', pageUp: 'PageUp', pageDown: 'PageDown', minus: 'Minus', equals: 'Equal', comma: 'Comma', period: 'Period', slash: 'Slash' };
function codeOf(e) {
    const k = String(e.key ?? '');
    if (/^[a-z]$/i.test(k)) return 'Key' + k.toUpperCase();
    if (/^[0-9]$/.test(k)) return 'Digit' + k;
    if (/^f([1-9]|1[0-2])$/i.test(k)) return k.toUpperCase();
    return CODES[k] ?? k;
}
const mods = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };
function updateMods(e, down) {
    const c = codeOf(e);
    if (c.startsWith('Shift')) mods.shiftKey = down;
    if (c.startsWith('Control')) mods.ctrlKey = down;
    if (c.startsWith('Alt')) mods.altKey = down;
    if (c.startsWith('Meta')) mods.metaKey = down;
}
const pointer = { x: 0, y: 0, buttons: 0 };
function pointerEvent(type, extra = {}) {
    const init = { bubbles: true, cancelable: true, clientX: pointer.x, clientY: pointer.y, pageX: pointer.x, pageY: pointer.y, screenX: pointer.x, screenY: pointer.y,
        pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: pointer.buttons, ...mods, ...extra };
    const target = mainContext?.canvas ?? doc.body;
    const ev = new hw.PointerEvent(type, init);
    target.dispatchEvent(ev);
    if (type.startsWith('pointer')) {
        const mouseType = type.replace('pointer', 'mouse');
        if (['mousemove', 'mousedown', 'mouseup'].includes(mouseType)) target.dispatchEvent(new hw.MouseEvent(mouseType, init));
    }
}
win.on('mouseMove', e => {
    pointer.x = e.x;
    pointer.y = e.y;
    pointerEvent('pointerrawupdate');
    pointerEvent('pointermove');
});
const BTN = { 1: 0, 2: 1, 3: 2 };
win.on('mouseButtonDown', e => {
    const b = BTN[e.button] ?? 0;
    pointer.buttons |= 1 << b;
    pointerEvent('pointerdown', { button: b });
});
win.on('mouseButtonUp', e => {
    const b = BTN[e.button] ?? 0;
    pointer.buttons &= ~(1 << b);
    pointerEvent('pointerup', { button: b });
});
win.on('mouseWheel', e => {
    const target = mainContext?.canvas ?? doc.body;
    target.dispatchEvent(new hw.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -e.dy * 100, deltaX: e.dx * 100, clientX: pointer.x, clientY: pointer.y, ...mods }));
});
win.on('keyDown', e => {
    updateMods(e, true);
    const code = codeOf(e);
    hw.dispatchEvent(new hw.KeyboardEvent('keydown', { bubbles: true, cancelable: true, code, key: e.key?.length === 1 ? e.key : code, repeat: !!e.repeat, ...mods }));
});
win.on('keyUp', e => {
    const code = codeOf(e);
    hw.dispatchEvent(new hw.KeyboardEvent('keyup', { bubbles: true, cancelable: true, code, key: e.key?.length === 1 ? e.key : code, ...mods }));
    updateMods(e, false);
});
win.on('resize', () => {
    renderer?.resize();
    hw.dispatchEvent(new hw.Event('resize'));
});
win.on('close', () => process.exit(0));
// Exit normally on signals too (so --cpu-prof writes its profile).
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

// The desktop bridge (~/.wosu storage, osu!lazer), as the Electron preload gives it.
g.wosuNative = createNative();

// ---------------------------------------------------------------------------
// Boot the built game
// ---------------------------------------------------------------------------

process.on('unhandledRejection', e => console.error('[unhandled]', e));
const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const entry = /<script[^>]*type="module"[^>]*src="\.?\/?([^"]+)"/.exec(html)?.[1];
if (!entry) throw new Error('no entry script in dist/index.html');
setImmediate(frame);
await import(pathToFileURL(path.join(DIST, entry)).href);
console.log('[sdl] game module loaded:', entry);

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
import { execFileSync } from 'node:child_process';
import { resolveObjectURL } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sdl from '@kmamal/sdl';
import gpu from '@kmamal/gpu';
import { Window as HappyWindow } from 'happy-dom';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import * as webAudio from 'node-web-audio-api';
import { createNative, relaunch } from './native.mjs';

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
    // copyExternalImageToTexture converts to the texture's format; writeTexture writes bytes as they are.
    if (String(destination.texture.format).startsWith('bgra')) data = swapRB(data);
    device.queue.writeTexture(
        { texture: destination.texture, mipLevel: destination.mipLevel ?? 0, origin: destination.origin ?? [0, 0, 0] },
        data,
        { bytesPerRow: px.width * 4, rowsPerImage: px.height },
        [w, h, 1],
    );
    };
}

/** RGBA → BGRA (or back). */
function swapRB(src) {
    const out = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i += 4) {
        out[i] = src[i + 2];
        out[i + 1] = src[i + 1];
        out[i + 2] = src[i];
        out[i + 3] = src[i + 3];
    }
    return out;
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

/**
 * node-web-audio-api panics (and Rust aborts the whole process) when a
 * source plays a buffer with no frames or channels — skins ship empty .wav
 * files to mute a hitsound, which browsers just play as silence. Such
 * sources don't start here; they report "ended" like a finished sound.
 */
{
    const Src = webAudio.AudioBufferSourceNode;
    const start = Src.prototype.start;
    Src.prototype.start = function (...args) {
        const b = this.buffer;
        if (!b || !(b.length > 0) || !(b.numberOfChannels > 0)) {
            setTimeout(() => {
                const ev = new Event('ended');
                this.onended?.(ev);
                this.dispatchEvent?.(ev);
            });
            return;
        }
        return start.apply(this, args);
    };
}

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

/** The always-on "Developer Edition" badge, composited by the host (no DOM here). */
const BADGE_WGSL = `
struct U { rect: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
    var c = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
    let q = c[i];
    var o: V;
    o.pos = vec4f(mix(u.rect.x, u.rect.z, q.x), mix(u.rect.y, u.rect.w, q.y), 0.0, 1.0);
    o.uv = q;
    return o;
}
@fragment fn fs(v: V) -> @location(0) vec4f { return textureSample(tex, smp, v.uv); }`;

function badgeBitmap(scale) {
    const text = 'DEVELOPER EDITION';
    let build = process.env.WOSU_BUILD;
    if (!build) {
        try { build = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: HERE }).toString().trim(); } catch { build = 'sdl'; }
    }
    build += ' · sdl';
    const fs1 = 9.5 * scale;
    const probe = createCanvas(4, 4).getContext('2d');
    probe.font = `600 ${fs1}px -apple-system, "Helvetica Neue", sans-serif`;
    const spaced = text.split('').join('\u200a');
    const tw = probe.measureText(spaced).width;
    probe.font = `600 ${fs1}px -apple-system, "Helvetica Neue", sans-serif`;
    const bw = probe.measureText(build).width;
    const padX = 10 * scale, h = Math.round(19 * scale), dot = 6 * scale, gap = 7 * scale;
    const w = Math.round(padX + dot + gap + tw + gap + bw + padX);
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    const r = h / 2;
    ctx.fillStyle = '#14161b';
    ctx.strokeStyle = '#2a2e36';
    ctx.lineWidth = scale;
    ctx.beginPath();
    ctx.roundRect(scale / 2, scale / 2, w - scale, h - scale, r);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#d9558f';
    ctx.beginPath();
    ctx.arc(padX + dot / 2, h / 2, dot / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `600 ${fs1}px -apple-system, "Helvetica Neue", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#9aa3ad';
    ctx.fillText(spaced, padX + dot + gap, h / 2 + 0.5 * scale);
    ctx.fillStyle = '#6b7480';
    ctx.fillText(build, padX + dot + gap + tw + gap, h / 2 + 0.5 * scale);
    const data = ctx.getImageData(0, 0, w, h).data;
    return { width: w, height: h, rgba: premultiply(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) };
}

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
            this.setupBadge(cfg.device, module);
        }
    }
    setupBadge(device) {
        const module = device.createShaderModule({ code: BADGE_WGSL });
        this.badgePipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: { module, entryPoint: 'vs' },
            fragment: {
                module, entryPoint: 'fs',
                targets: [{ format: SURFACE_FORMAT, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
            },
            primitive: { topology: 'triangle-list' },
        });
        const bmp = badgeBitmap(win.pixelWidth / win.width);
        this.badgeSize = [bmp.width, bmp.height];
        const tex = device.createTexture({ size: [bmp.width, bmp.height, 1], format: 'rgba8unorm', usage: gpu.GPUTextureUsage.TEXTURE_BINDING | gpu.GPUTextureUsage.COPY_DST });
        device.queue.writeTexture({ texture: tex }, bmp.rgba, { bytesPerRow: bmp.width * 4, rowsPerImage: bmp.height }, [bmp.width, bmp.height, 1]);
        this.badgeUniform = device.createBuffer({ size: 16, usage: gpu.GPUBufferUsage.UNIFORM | gpu.GPUBufferUsage.COPY_DST });
        this.badgeBind = device.createBindGroup({
            layout: this.badgePipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: this.badgeUniform } }, { binding: 1, resource: tex.createView() }, { binding: 2, resource: this.sampler }],
        });
        this.badgeRectFor = null;
    }
    /** Bottom centre, 6 points up, in pixels → clip space; rewritten only when the window size changes. */
    updateBadgeRect() {
        const W = win.pixelWidth, H = win.pixelHeight;
        const key = W + 'x' + H;
        if (this.badgeRectFor === key) return;
        this.badgeRectFor = key;
        const [bw, bh] = this.badgeSize;
        const bottom = 6 * (win.pixelWidth / win.width);
        const x0 = (W - bw) / 2, y0 = H - bottom - bh;
        const toX = x => (x / W) * 2 - 1, toY = y => 1 - (y / H) * 2;
        this.device.queue.writeBuffer(this.badgeUniform, 0, new Float32Array([toX(x0), toY(y0), toX(x0 + bw), toY(y0 + bh)]));
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
        if (this.badgePipeline) {
            this.updateBadgeRect();
            pass.setPipeline(this.badgePipeline);
            pass.setBindGroup(0, this.badgeBind);
            pass.draw(6);
        }
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
    // On-screen size (CSS), not the backing size: Pixi sets style.width/height to the window's
    // size, and maps the pointer by it. With a render resolution under 100% the two differ.
    el.getBoundingClientRect = () => {
        const cw = parseFloat(el.style.width) || w, ch = parseFloat(el.style.height) || h;
        return { x: 0, y: 0, left: 0, top: 0, width: cw, height: ch, right: cw, bottom: ch };
    };
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

// Browsers fall back to system fonts for glyphs a font lacks (Exo 2 has no ★); Skia only
// does if the families are listed. Append macOS's symbol fonts to every font the game sets.
const FALLBACK_FONTS = ', "Apple Symbols", "Arial Unicode MS", "Apple Color Emoji", sans-serif';
const fontDesc = Object.getOwnPropertyDescriptor(proto2d, 'font');
if (fontDesc?.set) {
    Object.defineProperty(proto2d, 'font', {
        configurable: true,
        get: fontDesc.get,
        set(v) {
            const s = String(v);
            fontDesc.set.call(this, s.includes('Apple Symbols') ? s : s + FALLBACK_FONTS);
        },
    });
}
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
            let ok = GlobalFonts.register(Buffer.from(await res.arrayBuffer()), this.family);
            // Skia here takes TTF/OTF, not WOFF2: use the package's TTF of the same font.
            if (!ok && /\.woff2$/i.test(m[1])) {
                const base = path.basename(m[1]).replace(/-[A-Za-z0-9_]{6,}(?=\.woff2$)/, '').replace(/\.woff2$/i, '.ttf');
                const ttf = path.resolve(HERE, '..', 'node_modules', '@fortawesome', 'fontawesome-free', 'webfonts', base);
                if (fs.existsSync(ttf)) ok = GlobalFonts.registerFromPath(ttf, this.family);
            }
            if (!ok) console.warn(`[sdl] font ${this.family} could not be registered (${m[1]})`);
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
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 wosu-sdl';
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
    // Some mirrors (catboy.best) turn away Node's default user agent with a 403.
    const headers = new Headers(init?.headers ?? (typeof input === 'object' ? input.headers : undefined));
    if (!headers.has('user-agent')) headers.set('user-agent', BROWSER_UA);
    return nodeFetch(url, { ...init, headers });
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

/**
 * The window surface must match the window's pixel size. SDL's resize event
 * can report the new size a moment before pixelWidth/Height settle (e.g.
 * entering fullscreen), leaving a strip of stale layer content at an edge:
 * check every frame and recreate the surface when they differ.
 */
let surfaceSize = '';
function syncSurfaceSize() {
    if (!renderer) return;
    const size = `${win.pixelWidth}x${win.pixelHeight}`;
    if (size === surfaceSize) return;
    if (surfaceSize) renderer.resize();
    surfaceSize = size;
    if (mainContext) mainContext.badgeRectFor = null;
}

/**
 * The game hides the OS cursor while it draws its own, with a class on <html>
 * and a "cursor: none" rule (src/app/Cursor.ts): mirror that in SDL.
 */
const NO_OS_CURSOR_CLASS = 'wosu-no-os-cursor';
let cursorShown = true;
function syncCursor() {
    const want = !doc.documentElement.classList.contains(NO_OS_CURSOR_CLASS);
    if (want !== cursorShown) {
        cursorShown = want;
        sdl.mouse.showCursor(want);
    }
}

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
    syncCursor();
    syncSurfaceSize();
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

/**
 * KeyboardEvent.code is the PHYSICAL key (SDL's scancode), whatever the
 * layout; .key is what the layout types. Using SDL's virtual key for .code
 * would make Z/X arrive as Cyrillic letters on a Russian layout.
 */
const SC_NAME = Object.fromEntries(Object.entries(sdl.keyboard.SCANCODE).map(([n, v]) => [v, n]));
const SC_CODE = {
    RETURN: 'Enter', ESCAPE: 'Escape', BACKSPACE: 'Backspace', TAB: 'Tab', SPACE: 'Space', MINUS: 'Minus', EQUALS: 'Equal',
    LEFTBRACKET: 'BracketLeft', RIGHTBRACKET: 'BracketRight', BACKSLASH: 'Backslash', SEMICOLON: 'Semicolon', APOSTROPHE: 'Quote',
    GRAVE: 'Backquote', COMMA: 'Comma', PERIOD: 'Period', SLASH: 'Slash', CAPSLOCK: 'CapsLock', INSERT: 'Insert', HOME: 'Home',
    PAGEUP: 'PageUp', DELETE: 'Delete', END: 'End', PAGEDOWN: 'PageDown', RIGHT: 'ArrowRight', LEFT: 'ArrowLeft', DOWN: 'ArrowDown',
    UP: 'ArrowUp', PRINTSCREEN: 'PrintScreen', NONUSBACKSLASH: 'IntlBackslash', KP_ENTER: 'NumpadEnter', KP_PERIOD: 'NumpadDecimal',
    KP_PLUS: 'NumpadAdd', KP_MINUS: 'NumpadSubtract', KP_MULTIPLY: 'NumpadMultiply', KP_DIVIDE: 'NumpadDivide',
    LCTRL: 'ControlLeft', RCTRL: 'ControlRight', LSHIFT: 'ShiftLeft', RSHIFT: 'ShiftRight', LALT: 'AltLeft', RALT: 'AltRight', LGUI: 'MetaLeft', RGUI: 'MetaRight',
};
function codeOf(e) {
    const n = SC_NAME[e.scancode] ?? '';
    if (/^[A-Z]$/.test(n)) return 'Key' + n;
    if (/^[0-9]$/.test(n)) return 'Digit' + n;
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(n)) return n;
    if (/^KP_[0-9]$/.test(n)) return 'Numpad' + n.slice(3);
    return SC_CODE[n] ?? n;
}
const KEY_NAMES = { return: 'Enter', enter: 'Enter', escape: 'Escape', backspace: 'Backspace', tab: 'Tab', space: ' ', delete: 'Delete',
    left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', home: 'Home', end: 'End', pageUp: 'PageUp', pageDown: 'PageDown',
    shift: 'Shift', ctrl: 'Control', alt: 'Alt', gui: 'Meta', capsLock: 'CapsLock' };
/** KeyboardEvent.key: the typed character for printable keys, else the key's name. */
function keyOf(e, code) {
    const k = e.key ?? '';
    if (k.length === 1) return e.shift ? k.toUpperCase() : k;
    if (KEY_NAMES[k]) return KEY_NAMES[k];
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(k)) return k.toUpperCase();
    return code;
}
const mods = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };
/** SDL reports the modifier state on every key event; mouse events reuse the latest. */
function updateMods(e) {
    mods.shiftKey = !!e.shift;
    mods.ctrlKey = !!e.ctrl;
    mods.altKey = !!e.alt;
    mods.metaKey = !!e.super;
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
    // SDL: positive dy scrolls away from the user; DOM: positive deltaY scrolls down. "flipped" = macOS natural scrolling.
    const f = e.flipped ? -1 : 1;
    const target = mainContext?.canvas ?? doc.body;
    const ev = new hw.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaMode: 0, deltaY: -e.dy * f * 100, deltaX: e.dx * f * 100 });
    // happy-dom's WheelEvent isn't a MouseEvent: no position or modifiers, which Pixi hit-tests with.
    const pos = { clientX: pointer.x, clientY: pointer.y, pageX: pointer.x, pageY: pointer.y, screenX: pointer.x, screenY: pointer.y, x: pointer.x, y: pointer.y, offsetX: pointer.x, offsetY: pointer.y, buttons: pointer.buttons, ...mods };
    for (const [k, v] of Object.entries(pos)) Object.defineProperty(ev, k, { value: v, configurable: true });
    target.dispatchEvent(ev);
});
/** The focused text field, if any (the game types through one hidden <input>). */
function focusedInput() {
    const el = doc.activeElement;
    return el && el.tagName === 'INPUT' ? el : null;
}

/** Browser default editing for a text field: what the key would do if not prevented. */
function editField(el, code) {
    const v = el.value ?? '';
    let a = el.selectionStart ?? v.length, b = el.selectionEnd ?? v.length;
    const set = (value, caret) => {
        el.value = value;
        el.setSelectionRange?.(caret, caret);
        el.dispatchEvent(new hw.Event('input', { bubbles: true }));
    };
    const cmd = mods.metaKey || mods.ctrlKey;
    if (code === 'Backspace') {
        if (a !== b) set(v.slice(0, a) + v.slice(b), a);
        else if (a > 0) {
            const from = cmd ? 0 : mods.altKey ? v.slice(0, a).replace(/\S+\s*$/, '').length : a - 1;
            set(v.slice(0, from) + v.slice(a), from);
        }
    } else if (code === 'Delete') {
        if (a !== b) set(v.slice(0, a) + v.slice(b), a);
        else if (a < v.length) set(v.slice(0, a) + v.slice(a + 1), a);
    } else if (code === 'ArrowLeft' || code === 'ArrowRight' || code === 'Home' || code === 'End') {
        let c = code === 'Home' || (cmd && code === 'ArrowLeft') ? 0 : code === 'End' || (cmd && code === 'ArrowRight') ? v.length : code === 'ArrowLeft' ? (a !== b ? a : a - 1) : (a !== b ? b : b + 1);
        c = Math.max(0, Math.min(v.length, c));
        el.setSelectionRange?.(c, c);
        el.dispatchEvent(new hw.Event('select', { bubbles: true }));
    } else if (cmd && code === 'KeyA') {
        el.setSelectionRange?.(0, v.length);
        el.dispatchEvent(new hw.Event('select', { bubbles: true }));
    } else if (cmd && code === 'KeyC') {
        execFileSync('/usr/bin/pbcopy', { input: v.slice(a, b) });
    } else if (cmd && code === 'KeyX') {
        execFileSync('/usr/bin/pbcopy', { input: v.slice(a, b) });
        set(v.slice(0, a) + v.slice(b), a);
    } else if (cmd && code === 'KeyV') {
        const text = execFileSync('/usr/bin/pbpaste').toString().replace(/[\r\n]+/g, ' ');
        set(v.slice(0, a) + text + v.slice(b), a + text.length);
    }
}

win.on('keyDown', e => {
    updateMods(e);
    const code = codeOf(e);
    // The modifier key itself is down from its own keydown on (SDL's flags lag one event).
    if (code.startsWith('Shift')) mods.shiftKey = true;
    if (code.startsWith('Control')) mods.ctrlKey = true;
    if (code.startsWith('Alt')) mods.altKey = true;
    if (code.startsWith('Meta')) mods.metaKey = true;
    const ev = new hw.KeyboardEvent('keydown', { bubbles: true, cancelable: true, code, key: keyOf(e, code), repeat: !!e.repeat, ...mods });
    const field = focusedInput();
    (field ?? hw).dispatchEvent(ev);
    if (field && !ev.defaultPrevented) editField(field, code);
});
win.on('keyUp', e => {
    updateMods(e);
    const code = codeOf(e);
    if (code.startsWith('Shift')) mods.shiftKey = false;
    if (code.startsWith('Control')) mods.ctrlKey = false;
    if (code.startsWith('Alt')) mods.altKey = false;
    if (code.startsWith('Meta')) mods.metaKey = false;
    (focusedInput() ?? hw).dispatchEvent(new hw.KeyboardEvent('keyup', { bubbles: true, cancelable: true, code, key: keyOf(e, code), ...mods }));
});
// Typed characters (after the keyboard layout and IME): into the focused field.
win.on('textInput', e => {
    const el = focusedInput();
    if (!el || mods.metaKey || mods.ctrlKey) return;
    const v = el.value ?? '';
    const a = el.selectionStart ?? v.length, b = el.selectionEnd ?? v.length;
    el.value = v.slice(0, a) + e.text + v.slice(b);
    el.setSelectionRange?.(a + e.text.length, a + e.text.length);
    el.dispatchEvent(new hw.Event('input', { bubbles: true }));
});
// Files dropped on the window: beatmaps, skins, replays, as in the Electron app.
win.on('dropFile', e => {
    try {
        const bytes = new Uint8Array(fs.readFileSync(e.file));
        g.wosuNative?.openFile({ name: path.basename(e.file), bytes });
    } catch (err) {
        console.warn('[sdl] drop failed', err);
    }
});
win.on('resize', () => {
    renderer?.resize();
    hw.dispatchEvent(new hw.Event('resize'));
});
// Focus: the game pauses on blur and drops to 30 fps in the background (see desktop.ts).
let focused = true;
doc.hasFocus = () => focused;
Object.defineProperty(doc, 'visibilityState', { get: () => (win.visible === false ? 'hidden' : 'visible'), configurable: true });
win.on('focus', () => {
    focused = true;
    hw.dispatchEvent(new hw.Event('focus'));
});
win.on('blur', () => {
    focused = false;
    hw.dispatchEvent(new hw.Event('blur'));
});
win.on('close', () => process.exit(0));
// Exit normally on signals too (so --cpu-prof writes its profile).
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

// <a download> clicks (screenshots, replays, skin exports): saved under ~/.wosu like the Electron app does.
const anchorClick = hw.HTMLAnchorElement.prototype.click;
hw.HTMLAnchorElement.prototype.click = function () {
    const name = this.getAttribute('download');
    const href = this.getAttribute('href') ?? '';
    if (name === null || !href.startsWith('blob:')) return anchorClick.call(this);
    const blob = resolveObjectURL(href);
    if (!blob) return;
    void blob.arrayBuffer().then(buf => g.wosuNative?.saveDownload(name || 'download', new Uint8Array(buf))).catch(e => console.warn('[sdl] save failed', e));
};

// location.reload() ("Restart now" after renderer/MSAA changes): a real restart of the host.
try {
    Object.defineProperty(hw.location, 'reload', { value: () => relaunch(), configurable: true });
} catch {
    hw.location.reload = () => relaunch();
}

// The desktop bridge (~/.wosu storage, osu!lazer), as the Electron preload gives it.
g.wosuNative = createNative({ onConfigChange: c => applyDisplayMode(c.displayMode) });
applyDisplayMode(g.wosuNative.config.initial.displayMode);

/** Settings → Graphics → Display mode (and F11): SDL's desktop fullscreen for both fullscreen kinds. */
function applyDisplayMode(mode) {
    const want = mode !== 'windowed';
    if (win.fullscreen !== want) win.setFullscreen(want);
}

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

/**
 * AUTOPLAY=1 (with WOSU_DEBUG=1 so the game exposes window.game): skip the
 * intro, start Autoplay on a dense map, and let the fps lines show gameplay.
 * The same map as the Electron profile: the most objects among 5-6.5* maps over 100 s.
 */
if (process.env.AUTOPLAY) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 100 && !(g.game && g.game.library.sets.length > 100); i++) await sleep(300);
    const game = g.game;
    if (!game) throw new Error('AUTOPLAY needs WOSU_DEBUG=1');
    game.screens.current?.begin?.();
    await sleep(2500);
    const c = [];
    for (const set of game.library.sets) for (const d of set.difficulties) if (d.stars >= 5 && d.stars <= 6.5 && d.length > 100000 && d.circles + d.sliders > 600) c.push({ set, d });
    c.sort((a, b) => (b.d.circles + b.d.sliders) - (a.d.circles + a.d.sliders));
    const pick = c[Math.floor(c.length / 3)];
    console.log(`[sdl] autoplay: ${pick.set.artist} - ${pick.set.title} [${pick.d.version}] ${pick.d.stars.toFixed(2)}*`);
    game.mods.value = new Set(['AT']);
    game.play({ set: pick.set, diff: pick.d });
}

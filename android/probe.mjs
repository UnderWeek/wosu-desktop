/**
 * Step-one probe for the Android host: Node + Dawn (Vulkan) on the
 * activity's window. Clears to a colour that follows the first finger and
 * logs fps / frame times / touch→frame latency once a second (logcat: wosu-js).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bridgeModule = { exports: {} };
process.dlopen(bridgeModule, `${process.env.WOSU_LIB_DIR}/libwosu.so`);
const bridge = bridgeModule.exports;
const gpu = require('@kmamal/gpu');

console.log(`node ${process.version} on ${process.platform}/${process.arch}`, JSON.stringify(bridge.info()));

const instance = gpu.create([]);
const adapter = await instance.requestAdapter();
const device = await adapter.requestDevice();
console.log('adapter', JSON.stringify(adapter.info ?? {}));

const PRESENT = process.env.WOSU_PRESENT || 'mailbox';
let renderer = null;
let size = [0, 0];
let touch = null;
let lastTouchAt = 0;
const latency = [];

function attach() {
    const w = bridge.window();
    if (!w) return;
    size = [w.width, w.height];
    try {
        renderer = gpu.renderGPUDeviceToWindow({ device, window: { _native: { gpu: w.gpu }, _pixelWidth: w.width, _pixelHeight: w.height }, presentMode: PRESENT });
    } catch (e) {
        console.log(`present mode ${PRESENT} failed (${e.message}); using fifo`);
        renderer = gpu.renderGPUDeviceToWindow({ device, window: { _native: { gpu: w.gpu }, _pixelWidth: w.width, _pixelHeight: w.height }, presentMode: 'fifo' });
    }
    console.log(`window ${w.width}x${w.height}, present ${PRESENT}`);
}

function handleEvents() {
    const ev = bridge.poll();
    const nowBridge = bridge.now();
    for (let i = 0; i < ev.length; i += 7) {
        const [type, action, id, x, y, time] = ev.subarray(i, i + 6);
        if (type === 1) attach();
        else if (type === 2) {
            renderer = null;
            globalThis.gc?.();
            bridge.ackWindowLost();
            console.log('window lost');
        } else if (type === 3) {
            size = [x, y];
            renderer?.resize?.();
        } else if (type === 4) {
            if (action === 0 || action === 1) touch = [x / size[0], y / size[1]];
            if (action === 0) {
                lastTouchAt = time;
                latency.push(nowBridge - time);
            }
            if (action >= 2) touch = null;
        }
    }
}

let frames = 0, worst = 0, since = performance.now();
function frame() {
    const t0 = performance.now();
    handleEvents();
    if (renderer) {
        const view = renderer.getCurrentTextureView();
        const c = touch ? { r: touch[0], g: touch[1], b: 0.6, a: 1 } : { r: 0.1, g: 0.1, b: 0.15, a: 1 };
        const enc = device.createCommandEncoder();
        enc.beginRenderPass({ colorAttachments: [{ view, clearValue: c, loadOp: 'clear', storeOp: 'store' }] }).end();
        device.queue.submit([enc.finish()]);
        renderer.swap();
        frames++;
        worst = Math.max(worst, performance.now() - t0);
    }
    const now = performance.now();
    if (now - since >= 1000) {
        const lat = latency.length ? (latency.reduce((a, b) => a + b, 0) / latency.length).toFixed(2) : '-';
        console.log(`fps ${(frames * 1000 / (now - since)).toFixed(0)} worst ${worst.toFixed(2)}ms touch→js ${lat}ms rss ${(process.memoryUsage().rss / 1048576).toFixed(0)}MB`);
        frames = 0; worst = 0; since = now; latency.length = 0;
    }
    setImmediate(frame);
}
frame();

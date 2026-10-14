/**
 * Audio debugger: what is making sound, and how it got there.
 *
 * - Every music event (track play/pause/rate/fail, menu music hand-offs,
 *   preview streams) goes through `audioLog`: kept in a ring buffer and
 *   printed as `[audio] …` (the desktop shell writes those to
 *   ~/.wosu/logs).
 * - Ctrl+Shift+A toggles a live panel listing every source that can be
 *   audible right now: MusicTracks (decoded songs, incl. the time-stretch
 *   worklet), long AudioBufferSourceNodes, and <audio>/<video> elements,
 *   plus the menu music controller's state and the screen stack.
 */
import { debugCard, esc } from './panel';

type Describe = () => string;

const RING = 300;
const ring: string[] = [];
const t0 = performance.now();

function stamp(): string {
    return ((performance.now() - t0) / 1000).toFixed(3).padStart(9);
}

/** Log one audio event (kept for the panel, printed for the log file). */
export function audioLog(event: string, detail = ''): void {
    const line = `${stamp()} ${event}${detail ? ' ' + detail : ''}`;
    ring.push(line);
    if (ring.length > RING) ring.shift();
    console.info(`[audio] ${event}${detail ? ' ' + detail : ''}`);
}

/** Live things the panel describes (MusicTracks register themselves). */
const tracked = new Map<object, Describe>();

export function audioTrack(owner: object, describe: Describe): void {
    tracked.set(owner, describe);
}

export function audioUntrack(owner: object): void {
    tracked.delete(owner);
}

// ---------------------------------------------------------------------------
// Raw sources: long buffer sources and media elements, whoever made them
// ---------------------------------------------------------------------------

interface SourceInfo {
    duration: number;
    startedAt: number;
    rate: AudioParam;
}

const sources = new Map<AudioBufferSourceNode, SourceInfo>();
const media = new Set<HTMLMediaElement>();
let patched = false;

/** Buffers longer than this are songs, not hitsounds. */
const LONG_SOURCE_SEC = 8;

function patchSources(): void {
    if (patched || typeof AudioBufferSourceNode === 'undefined') return;
    patched = true;
    const proto = AudioBufferSourceNode.prototype;
    const start = proto.start;
    const stop = proto.stop;
    proto.start = function (this: AudioBufferSourceNode, ...args: Parameters<typeof start>) {
        const d = this.buffer?.duration ?? 0;
        if (d >= LONG_SOURCE_SEC) {
            sources.set(this, { duration: d, startedAt: performance.now(), rate: this.playbackRate });
            this.addEventListener('ended', () => sources.delete(this), { once: true });
        }
        return start.apply(this, args);
    };
    proto.stop = function (this: AudioBufferSourceNode, ...args: Parameters<typeof stop>) {
        sources.delete(this);
        return stop.apply(this, args);
    };
    if (typeof HTMLMediaElement !== 'undefined') {
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
            media.add(this);
            return play.call(this);
        };
    }
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

let panel: HTMLDivElement | null = null;
let body: HTMLDivElement | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let stateProvider: (() => string) | null = null;

/** Extra state lines (the game's music controller, screens). */
export function audioDebugState(fn: () => string): void {
    stateProvider = fn;
}

function dot(color: string): string {
    return `<span class="wd-dot" style="background:${color}"></span>`;
}

function row(color: string, html: string): string {
    return `<div class="wd-row">${dot(color)}<span>${html}</span></div>`;
}

const ON = '#5fe0a0', OFF = '#56606b', WARN = '#ffd166';

function render(): string {
    const out: string[] = [];
    if (stateProvider) {
        let state = '';
        try { state = stateProvider(); } catch (e) { state = `state error: ${String(e)}`; }
        out.push('<div class="wd-section">State</div>');
        for (const line of state.split('\n')) out.push(`<div class="wd-row wd-mono">${esc(line)}</div>`);
    }
    out.push(`<div class="wd-section">Songs (MusicTrack) · ${tracked.size}</div>`);
    if (!tracked.size) out.push('<div class="wd-sub">none</div>');
    for (const d of tracked.values()) {
        const text = d();
        out.push(row(text.includes('PLAYING') ? (text.includes('FAILED') ? WARN : ON) : OFF, `<span class="wd-mono">${esc(text)}</span>`));
    }
    out.push(`<div class="wd-section">Long buffer sources · ${sources.size}</div>`);
    if (!sources.size) out.push('<div class="wd-sub">none</div>');
    for (const src of sources.values()) {
        const running = (performance.now() - src.startedAt) / 1000;
        out.push(row(ON, `<span class="wd-mono">${src.duration.toFixed(0)} s buffer · running ${running.toFixed(1)} s · rate ${src.rate.value.toFixed(3)}</span>`));
    }
    const playing = [...media].filter(m => !m.paused && !m.ended);
    out.push(`<div class="wd-section">Media elements playing · ${playing.length}</div>`);
    if (!playing.length) out.push('<div class="wd-sub">none</div>');
    for (const m of playing) {
        const src = m.currentSrc.startsWith('blob:') ? 'blob (song stream)' : m.currentSrc.slice(-50);
        out.push(row(ON, `<span class="wd-mono">${m.tagName.toLowerCase()} ${esc(src)} · ${m.currentTime.toFixed(1)} s · vol ${m.volume.toFixed(2)}${m.muted ? ' · muted' : ''}</span>`));
    }
    out.push('<div class="wd-section">Recent events</div>');
    for (const line of ring.slice(-14)) out.push(`<div class="wd-row wd-mono">${esc(line)}</div>`);
    return out.join('');
}

export function toggleAudioDebug(): void {
    if (panel) {
        panel.remove();
        panel = body = null;
        if (timer) clearInterval(timer);
        timer = null;
        return;
    }
    panel = debugCard({ top: '16px', left: '16px' }, 720);
    panel.innerHTML = '<div class="wd-head"><span class="wd-title">Audio</span><span class="wd-pill">live</span><span class="wd-hint">Ctrl+Shift+A · events logged to ~/.wosu/logs</span></div>';
    body = document.createElement('div');
    panel.appendChild(body);
    const update = () => { if (body) body.innerHTML = render(); };
    update();
    timer = setInterval(update, 250);
}

/** Install source tracking and the Ctrl+Shift+A panel. */
export function installAudioDebug(): void {
    patchSources();
    window.addEventListener('keydown', e => {
        if (e.code === 'KeyA' && e.shiftKey && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            e.stopPropagation();
            toggleAudioDebug();
        }
    }, { capture: true });
}

/**
 * Input debugger (Ctrl+Shift+P): what the pointer device really delivers.
 *
 * Tiles: report rate (`pointerrawupdate`, one per device report), the
 * longest gap between reports, how late reports reach the page
 * (event.timeStamp → handler) and the frame rate. Charts: every gap of
 * the last two seconds (stalls stand out as spikes) and the report rate
 * over the last 30 seconds. Each second is also logged as `[input] …`
 * (~/.wosu/logs in the desktop app) while the panel is open.
 */
import { chartCanvas, debugCard, grade } from './panel';

interface Second {
    raw: number;
    moves: number;
    coalesced: number;
    gaps: number[];
    lat: number[];
    frames: number;
    maxFrame: number;
    types: Set<string>;
    startedAt: number;
    /** How long this window really lasted: a saturated main thread delays the timer, so never assume 1 s. */
    seconds: number;
}

const fresh = (): Second => ({ raw: 0, moves: 0, coalesced: 0, gaps: [], lat: [], frames: 0, maxFrame: 0, types: new Set(), startedAt: performance.now(), seconds: 1 });

function pct(a: number[], p: number): number {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

const GAP_WINDOW_MS = 2000;
const RATE_HISTORY = 30;

let card: HTMLDivElement | null = null;
let tilesEl: HTMLDivElement | null = null;
let gapChart: ReturnType<typeof chartCanvas> | null = null;
let rateChart: ReturnType<typeof chartCanvas> | null = null;
let cur = fresh();
let last: Second | null = null;
let lastRaw = 0;
let lastFrame = 0;
let tick: ReturnType<typeof setInterval> | null = null;
/** [time, gap ms] of recent reports. */
let gapPoints: [number, number][] = [];
const rates: number[] = [];

function onRaw(e: PointerEvent): void {
    const now = performance.now();
    cur.raw++;
    cur.types.add(e.pointerType);
    cur.lat.push(now - e.timeStamp);
    if (lastRaw) {
        const gap = e.timeStamp - lastRaw;
        cur.gaps.push(gap);
        gapPoints.push([e.timeStamp, gap]);
    }
    lastRaw = e.timeStamp;
}

function onMove(e: PointerEvent): void {
    cur.moves++;
    cur.coalesced += typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents().length : 1;
}

function tile(label: string, value: string, unit: string, cls: string, sub: string): string {
    return `<div class="wd-tile"><div class="wd-label">${label}</div><div class="wd-value ${cls}">${value}<small>${unit}</small></div><div class="wd-sub">${sub}</div></div>`;
}

function renderTiles(): void {
    if (!tilesEl) return;
    const s = last;
    if (!s || (!s.raw && !s.moves)) {
        tilesEl.innerHTML = tile('Report rate', '—', '', '', 'move the pen or mouse') + tile('Max gap', '—', '', '', '') +
            tile('Delivery', '—', '', '', '') + tile('Frames', s ? String(perSec(s.frames, s)) : '—', 'fps', '', s ? `worst ${s.maxFrame.toFixed(1)} ms` : '');
        return;
    }
    const rate = perSec(s.raw, s);
    const peak = Math.max(...rates, rate);
    const rateCls = rate >= peak * 0.9 ? 'wd-good' : rate >= peak * 0.6 ? 'wd-warn' : 'wd-bad';
    const maxGap = s.gaps.length ? Math.max(...s.gaps) : 0;
    const p50 = pct(s.gaps, 0.5);
    const late99 = pct(s.lat, 0.99);
    tilesEl.innerHTML =
        tile('Report rate', String(rate), 'Hz', rateCls, `${[...s.types].join(' + ') || '—'} · peak ${peak} Hz`) +
        tile('Max gap', maxGap.toFixed(1), 'ms', grade(maxGap, Math.max(4, p50 * 4), Math.max(12, p50 * 12)), `typical ${p50.toFixed(2)} ms`) +
        tile('Delivery', late99.toFixed(2), 'ms p99', grade(late99, 2, 8), `median ${pct(s.lat, 0.5).toFixed(2)} ms`) +
        tile('Frames', String(perSec(s.frames, s)), 'fps', grade(s.maxFrame, 8, 20), `worst ${s.maxFrame.toFixed(1)} ms · ${s.moves ? (s.coalesced / s.moves).toFixed(1) : 0} reports/frame` + (s.seconds > 1.5 ? ` · timer ${s.seconds.toFixed(1)} s late` : ''));
}

function drawGaps(now: number): void {
    if (!gapChart) return;
    const { ctx } = gapChart;
    const { w, h } = gapChart.resize();
    ctx.clearRect(0, 0, w, h);
    gapPoints = gapPoints.filter(([t]) => now - t <= GAP_WINDOW_MS);
    const typical = pct(gapPoints.map(p => p[1]), 0.5) || 1;
    // Log scale: 0.25 ms … 64 ms, so both 1 kHz jitter and long stalls fit.
    const lo = Math.log2(0.25), hi = Math.log2(64);
    const y = (ms: number) => h - 4 - ((Math.log2(Math.max(0.25, Math.min(64, ms))) - lo) / (hi - lo)) * (h - 8);
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    for (const ms of [1, 4, 16]) {
        ctx.strokeStyle = 'rgba(255,255,255,.07)';
        ctx.beginPath();
        ctx.moveTo(0, y(ms));
        ctx.lineTo(w, y(ms));
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,.35)';
        ctx.fillText(`${ms} ms`, 4, y(ms) - 3);
    }
    for (const [t, gap] of gapPoints) {
        const x = w - ((now - t) / GAP_WINDOW_MS) * w;
        ctx.fillStyle = gap <= typical * 4 ? 'rgba(95,224,160,.75)' : gap <= typical * 12 ? 'rgba(255,209,102,.95)' : 'rgba(255,107,122,1)';
        ctx.fillRect(x - 1, y(gap) - 1, 2.2, 2.2);
    }
}

function drawRates(): void {
    if (!rateChart) return;
    const { ctx } = rateChart;
    const { w, h } = rateChart.resize();
    ctx.clearRect(0, 0, w, h);
    const peak = Math.max(1, ...rates);
    const bw = w / RATE_HISTORY;
    rates.forEach((r, i) => {
        const x = w - (rates.length - i) * bw;
        const bh = (r / peak) * (h - 14);
        ctx.fillStyle = r >= peak * 0.9 ? 'rgba(95,224,160,.7)' : r >= peak * 0.6 ? 'rgba(255,209,102,.8)' : 'rgba(255,107,122,.85)';
        ctx.fillRect(x + 1, h - bh, bw - 2, bh);
    });
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.fillText(`${peak} Hz`, 4, 11);
}

function frame(t: number): void {
    if (!card) return;
    if (lastFrame) {
        const d = t - lastFrame;
        cur.frames++;
        if (d > cur.maxFrame) cur.maxFrame = d;
    }
    lastFrame = t;
    if (performance.now() - cur.startedAt >= 1000) flush();
    drawGaps(performance.now());
    requestAnimationFrame(frame);
}

/** Per second over the window's real length. */
function perSec(n: number, s: Second): number {
    return Math.round(n / s.seconds);
}

function flush(): void {
    cur.seconds = Math.max(0.001, (performance.now() - cur.startedAt) / 1000);
    last = cur;
    cur = fresh();
    if (last.raw || last.moves) {
        rates.push(perSec(last.raw, last));
        if (rates.length > RATE_HISTORY) rates.shift();
        const g = last.gaps;
        console.info(`[input] window ${last.seconds.toFixed(2)}s rate ${perSec(last.raw, last)}Hz [${[...last.types].join(',')}] gap p50 ${pct(g, 0.5).toFixed(2)} p99 ${pct(g, 0.99).toFixed(2)} max ${(g.length ? Math.max(...g) : 0).toFixed(1)}ms ` +
            `late p50 ${pct(last.lat, 0.5).toFixed(2)} p99 ${pct(last.lat, 0.99).toFixed(2)}ms fps ${perSec(last.frames, last)} worst ${last.maxFrame.toFixed(1)}ms moves ${perSec(last.moves, last)}/s (${last.moves ? (last.coalesced / last.moves).toFixed(1) : 0}/frame)`);
    }
    renderTiles();
    drawRates();
}

export function toggleInputDebug(): void {
    const opts = { capture: true, passive: true } as const;
    if (card) {
        card.remove();
        card = tilesEl = null;
        gapChart = rateChart = null;
        window.removeEventListener('pointerrawupdate', onRaw as EventListener, opts);
        window.removeEventListener('pointermove', onMove, opts);
        if (tick) clearInterval(tick);
        tick = null;
        return;
    }
    card = debugCard({ bottom: '16px', left: '16px' }, 620);
    card.innerHTML = `<div class="wd-head"><span class="wd-title">Input</span><span class="wd-pill">live</span><span class="wd-hint">Ctrl+Shift+P · logged to ~/.wosu/logs</span></div>`;
    tilesEl = document.createElement('div');
    tilesEl.className = 'wd-tiles';
    card.appendChild(tilesEl);
    const s1 = document.createElement('div');
    s1.className = 'wd-section';
    s1.textContent = 'Gap between reports · last 2 s';
    gapChart = chartCanvas(96);
    const s2 = document.createElement('div');
    s2.className = 'wd-section';
    s2.textContent = 'Report rate · last 30 s';
    rateChart = chartCanvas(44);
    card.append(s1, gapChart.canvas, s2, rateChart.canvas);
    cur = fresh();
    last = null;
    lastRaw = lastFrame = 0;
    gapPoints = [];
    rates.length = 0;
    window.addEventListener('pointerrawupdate', onRaw as EventListener, opts);
    window.addEventListener('pointermove', onMove, opts);
    requestAnimationFrame(frame);
    tick = setInterval(flush, 1000);
    renderTiles();
}

export function installInputDebug(): void {
    window.addEventListener('keydown', e => {
        if (e.code === 'KeyP' && e.shiftKey && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            e.stopPropagation();
            toggleInputDebug();
        }
    }, { capture: true });
}

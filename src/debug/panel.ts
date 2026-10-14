/**
 * Shared look for the debug overlays (DOM, above the game canvas): a dark
 * translucent card with a header, stat tiles and chart slots.
 */

const STYLE_ID = 'wosu-debug-style';

const CSS = `
.wd-card{position:fixed;z-index:99999;pointer-events:none;color:#e8eef2;
  font:12px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;font-variant-numeric:tabular-nums;
  background:#101218;border:1px solid #262a32;border-radius:14px;padding:14px 16px;}
.wd-head{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.wd-title{font-weight:650;font-size:13px;letter-spacing:.02em}
.wd-hint{margin-left:auto;color:#8a96a3;font-size:11px}
.wd-pill{font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:99px;background:rgba(255,255,255,.08);color:#b9c4cf;text-transform:uppercase;letter-spacing:.05em}
.wd-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:12px}
.wd-tile{background:rgba(255,255,255,.04);border-radius:10px;padding:8px 10px;min-width:0}
.wd-label{color:#8a96a3;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}
.wd-value{font-size:20px;font-weight:650;margin-top:2px;white-space:nowrap}
.wd-value small{font-size:11px;font-weight:500;color:#8a96a3;margin-left:3px}
.wd-sub{color:#8a96a3;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wd-good{color:#5fe0a0}.wd-warn{color:#ffd166}.wd-bad{color:#ff6b7a}
.wd-chart{display:block;width:100%;border-radius:8px;background:rgba(255,255,255,.03);margin-top:4px}
.wd-section{color:#8a96a3;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;margin:10px 0 2px}
.wd-row{display:flex;gap:8px;align-items:baseline;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wd-mono{font:11px/1.45 ui-monospace,"SF Mono",Menlo,monospace;color:#c9d3dc}
.wd-dot{width:7px;height:7px;border-radius:50%;flex:none;transform:translateY(-1px)}
`;

function ensureStyle(): void {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
}

export function debugCard(position: Partial<Record<'top' | 'left' | 'right' | 'bottom', string>>, width: number): HTMLDivElement {
    ensureStyle();
    const card = document.createElement('div');
    card.className = 'wd-card';
    card.style.width = `min(${width}px, calc(100vw - 32px))`;
    for (const [k, v] of Object.entries(position)) card.style.setProperty(k, v);
    document.body.appendChild(card);
    return card;
}

export function esc(s: string): string {
    return s.replace(/[&<>]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/** good / warn / bad class for a value where lower is better. */
export function grade(v: number, good: number, warn: number): string {
    return v <= good ? 'wd-good' : v <= warn ? 'wd-warn' : 'wd-bad';
}

/** A canvas sized for the device pixel ratio; returns its 2D context in CSS pixels. */
export function chartCanvas(height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; resize: () => { w: number; h: number } } {
    const canvas = document.createElement('canvas');
    canvas.className = 'wd-chart';
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d')!;
    const resize = () => {
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth || 300;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(height * dpr)) {
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(height * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { w, h: height };
    };
    return { canvas, ctx, resize };
}

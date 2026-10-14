/**
 * "Developer Edition" badge (desktop app): bottom centre, above everything
 * from launch to quit, like lazer's DEVELOPER BUILD banner. Readable at
 * a glance, quiet otherwise: small caps, low contrast, no motion, and
 * clicks pass through it. Deliberately opaque and effect-free: a blur or
 * translucency over the game canvas is recomposited every frame.
 */

const CSS = `
.wosu-devbadge{position:fixed;left:50%;bottom:6px;transform:translateX(-50%);z-index:99990;pointer-events:none;user-select:none;
  display:flex;align-items:center;gap:7px;padding:3px 10px 3px 8px;border-radius:99px;
  font:600 9.5px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;
  color:#9aa3ad;background:#14161b;border:1px solid #2a2e36;white-space:nowrap}
.wosu-devbadge i{width:6px;height:6px;border-radius:50%;background:#d9558f}
.wosu-devbadge b{font-weight:600;color:#6b7480;letter-spacing:.08em;text-transform:none}
`;

export function showDevBadge(build: string): void {
    if (document.querySelector('.wosu-devbadge')) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    const badge = document.createElement('div');
    badge.className = 'wosu-devbadge';
    badge.setAttribute('aria-hidden', 'true');
    badge.innerHTML = `<i></i>Developer Edition<b>${build.replace(/[^\w.-]/g, '')}</b>`;
    document.body.appendChild(badge);
}

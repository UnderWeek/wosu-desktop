import { inject } from '@vercel/analytics';
import { Game } from './app/Game';
import { audioDebugState, installAudioDebug } from './debug/AudioDebug';
import { installInputDebug } from './debug/InputDebug';
import { showDevBadge } from './native/DevBadge';
import { isDesktop } from './native/desktop';
import { native } from './native/native';
import { installFileLocalStorage } from './native/localStore';

/**
 * Entry point: the whole game (menus included) is one PixiJS application
 * rendered into #app. See src/app/Game.ts for the service wiring.
 */
async function main(): Promise<void> {
    // Desktop: settings live in ~/.wosu/localstorage.json (shared by the Electron and SDL builds).
    installFileLocalStorage(native);
    // Vercel Web Analytics (page views only; a no-op in development).
    // (not in the desktop app, which has no Vercel endpoint).
    if (!isDesktop) inject();
    const host = document.getElementById('app');
    if (!host) throw new Error('#app host element missing');
    try {
        // Desktop app: on screen from launch to quit.
        if (isDesktop) showDevBadge(__BUILD_INFO__);
        installAudioDebug();
        installInputDebug();
        const game = await Game.boot(host);
        audioDebugState(() => `${game.music.debugState()}\nscreens: ${game.screens.screens.map(s => s.constructor.name).join(' > ')}`);
        if (import.meta.env.DEV || native?.debug) (window as unknown as { game: Game }).game = game;
    } catch (e) {
        console.error('failed to start', e);
        showFatal(host, e);
    }
}

/**
 * Last-resort message when no renderer can start (no WebGL/WebGPU). This
 * is the only text ever drawn outside the canvas, because without a
 * renderer there is no canvas to draw into.
 */
function showFatal(host: HTMLElement, error: unknown): void {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
        'color:#eee;font:16px system-ui,sans-serif;text-align:center;padding:24px;background:#111;';
    box.textContent = 'wosu! could not start: your browser or device does not support WebGL or WebGPU. ' +
        `(${error instanceof Error ? error.message : String(error)})`;
    host.appendChild(box);
}

void main();

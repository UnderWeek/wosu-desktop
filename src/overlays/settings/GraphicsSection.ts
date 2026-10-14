import type { RendererPreference } from '../../app/App';
import type { Game } from '../../app/Game';
import { desktopSettings } from '../../native/desktop';
import type { DisplayMode } from '../../native/native';
import { Colors } from '../../ui/theme';
import { checkboxRow, dropdownRow, mult, noticeRow, pct, sliderRow, textRow, type SettingsRow } from './rows';
import type { SectionDef } from './types';

export function graphicsSection(game: Game): SectionDef {
    const s = game.settings;
    const kind = game.app.rendererKind === 'webgpu' ? 'WebGPU' : 'WebGL';
    const fallback = game.app.fellBackFrom === 'webgpu' ? ' (WebGPU was requested but is unavailable here)' : '';
    return {
        id: 'graphics',
        title: 'Graphics',
        icon: 'desktop',
        subsections: [
            {
                title: 'Renderer',
                rows: [
                    dropdownRow<RendererPreference>('Renderer', [
                        { value: 'auto', label: 'Automatic (WebGPU, else WebGL)' },
                        { value: 'webgl', label: 'WebGL' },
                        { value: 'webgpu', label: 'WebGPU' },
                    ], s.renderer, { keywords: 'webgpu webgl gpu' }),
                    textRow(`Currently rendering with ${kind}${fallback}.`, { color: Colors.grayA, size: 12 }).row,
                    noticeRow('Some graphics changes take effect after a restart.', Colors.yellow, 'warning', {
                        visibleWhen: s.restartRequired,
                        action: { text: 'Restart now', onClick: () => game.restart() },
                        keywords: 'restart reload',
                    }),
                    ...desktopRows(),
                    dropdownRow('Frame limiter', [
                        // Desktop without vsync: 0 really is uncapped.
                        { value: 0, label: desktopSettings && !desktopSettings.launchedWithVsync ? 'Unlimited' : 'VSync' },
                        { value: 30, label: '30 fps' },
                        { value: 60, label: '60 fps' },
                        { value: 120, label: '120 fps' },
                        { value: 144, label: '144 fps' },
                        { value: 240, label: '240 fps' },
                        ...(desktopSettings ? [360, 480, 1000].map(v => ({ value: v, label: `${v} fps` })) : []),
                    ], s.frameLimit, { keywords: 'fps framerate unlimited' }),
                    checkboxRow('Show FPS counter', s.showFps, { keywords: 'framerate frame time' }),
                    checkboxRow('Anti-aliasing (MSAA)', s.antialias, { keywords: 'msaa smooth edges', description: 'Smooths shape edges. Requires a restart.' }),
                ],
            },
            {
                title: 'Layout',
                rows: [
                    sliderRow('Render resolution', s.resolutionScale, pct, { description: 'Lower values improve performance on slow devices.' }),
                    sliderRow('UI scale', s.uiScale, mult, { keywords: 'size interface' }),
                    checkboxRow('Background parallax', s.parallax, { keywords: 'parallax motion' }),
                ],
            },
        ],
    };
}

/** Desktop app only: window mode and vsync. */
function desktopRows(): SettingsRow[] {
    const d = desktopSettings;
    if (!d) return [];
    return [
        dropdownRow<DisplayMode>('Display mode', [
            { value: 'windowed', label: 'Windowed' },
            { value: 'borderless', label: 'Borderless fullscreen' },
            { value: 'fullscreen', label: 'Fullscreen (own Space)' },
        ], d.displayMode, { keywords: 'fullscreen window borderless screen', description: 'F11 or Alt+Enter switches between windowed and the last fullscreen mode.' }),
        checkboxRow('Retina resolution', d.hidpi, { keywords: 'retina hidpi dpi resolution sharp performance', description: 'Off: renders at 1 pixel per point and lets macOS upscale (like osu!lazer). Much faster on Retina screens, slightly softer image.' }),
        checkboxRow('VSync', d.vsync, { keywords: 'vsync tearing fps framerate unlimited', description: 'Off: frames are not tied to the display refresh rate (lowest input latency; use the frame limiter to cap). Requires a restart.' }),
        noticeRow('VSync changes apply after restarting the app.', Colors.yellow, 'warning', {
            visibleWhen: d.restartRequired,
            action: { text: 'Restart now', onClick: () => d.relaunch() },
            keywords: 'restart vsync',
        }),
    ];
}

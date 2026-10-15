import type { Game } from '../../app/Game';
import type { ConfineMouseMode } from '../../settings/Settings';
import type { Slider } from '../../ui/Slider';
import { desktopSettings } from '../../native/desktop';
import { checkboxRow, dropdownRow, keyBindRow, sliderRow } from './rows';
import type { SectionDef } from './types';

/** lazer's `{v:0.##}x`. */
const sensitivity = (v: number): string => `${Number(v.toFixed(2))}x`;

export function inputSection(game: Game): SectionDef {
    const s = game.settings;
    // These ride on the browser's pointer lock, which the native host (SDL) doesn't provide yet.
    const disabled = desktopSettings?.host === 'sdl' ? 'Not available in the native desktop app yet.' : undefined;
    const sensitivityRow = sliderRow('Cursor sensitivity', s.cursorSensitivity, sensitivity, {
        keywords: 'speed velocity mouse raw',
        disabled,
    });
    // lazer disables sensitivity unless high precision (relative) mode is on.
    s.highPrecisionMouse.bind(on => ((sensitivityRow.control as Slider).enabled = on), true);
    return {
        id: 'input',
        title: 'Input',
        icon: 'keyboard',
        subsections: [
            {
                title: 'Keyboard',
                rows: [
                    keyBindRow('Left button', s.keyLeft, { keywords: 'k1 z' }),
                    keyBindRow('Right button', s.keyRight, { keywords: 'k2 x' }),
                ],
            },
            {
                title: 'Mouse',
                rows: [
                    checkboxRow('High precision mouse', s.highPrecisionMouse, {
                        keywords: 'raw input relative cursor sensitivity speed velocity pointer lock',
                        description: 'Attempts to bypass any operating system mouse acceleration. During gameplay the pointer is locked to the game; Esc pauses and frees it. Tablets and touch keep absolute positioning.',
                        disabled,
                    }),
                    sensitivityRow,
                    dropdownRow<ConfineMouseMode>('Confine mouse cursor to window', [
                        { value: 'never', label: 'Never' },
                        { value: 'duringGameplay', label: 'During Gameplay' },
                    ], s.confineMouse, {
                        keywords: 'pointer lock capture monitor',
                        description: 'Keeps the cursor inside the game while playing (pointer lock). High precision mouse always does.',
                        disabled,
                    }),
                    checkboxRow('Mouse buttons in gameplay', s.mouseButtons, { keywords: 'click m1 m2', description: 'Turn off to only hit with the keyboard.' }),
                    checkboxRow('Mouse wheel changes volume in gameplay', s.wheelVolumeInGameplay, { keywords: 'scroll' }),
                ],
            },
        ],
    };
}

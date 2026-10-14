import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { App } from '../../src/app/App';
import { GameplayInput } from '../../src/gameplay/input/GameplayInput';
import { GameSettings } from '../../src/settings/Settings';

/** A pointer event as GameplayInput reads it (the test environment has no DOM). */
function pointer(type: string, pointerType: string, extra: Record<string, unknown> = {}): Event {
    return Object.assign(new Event(type), { pointerType, pointerId: 1, button: 0, clientX: 10, clientY: 20, ...extra });
}

describe('GameplayInput: pen taps and "Mouse buttons in gameplay"', () => {
    const g = globalThis as { window?: EventTarget };
    let had: EventTarget | undefined;
    beforeEach(() => {
        had = g.window;
        g.window = new EventTarget();
    });
    afterEach(() => {
        g.window = had;
    });

    function setup(mouseButtons: boolean) {
        const settings = new GameSettings();
        settings.mouseButtons.value = mouseButtons;
        const app = { toLogical: (x: number, y: number) => ({ x, y }) } as unknown as App;
        const input = new GameplayInput(app, settings, () => 1000, { x: 0, y: 0 });
        input.enabled = true;
        const presses: string[] = [];
        input.pressed.add((_t, _x, _y, b) => presses.push(b));
        return { input, presses };
    }

    test('mouse buttons off: a pen tap only aims', () => {
        const { input, presses } = setup(false);
        g.window!.dispatchEvent(pointer('pointerdown', 'pen'));
        expect(presses).toEqual([]);
        expect([input.x, input.y]).toEqual([10, 20]);
        input.dispose();
    });

    test('mouse buttons on: a pen tap presses', () => {
        const { input, presses } = setup(true);
        g.window!.dispatchEvent(pointer('pointerdown', 'pen'));
        expect(presses).toEqual(['M1']);
        input.dispose();
    });

    test('touch always presses (touchscreens have nothing else)', () => {
        const { input, presses } = setup(false);
        g.window!.dispatchEvent(pointer('pointerdown', 'touch'));
        expect(presses).toEqual(['M1']);
        input.dispose();
    });

    test('mouse buttons off: a mouse click does nothing', () => {
        const { input, presses } = setup(false);
        g.window!.dispatchEvent(pointer('pointerdown', 'mouse'));
        expect(presses).toEqual([]);
        input.dispose();
    });
});

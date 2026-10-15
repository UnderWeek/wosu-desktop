import { Container } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { Screen, ScreenStack } from '../../src/app/Screen';
import type { Game } from '../../src/app/Game';

const log: string[] = [];

class Menu extends Screen {}
class Select extends Screen {
    constructor(readonly generation = 1) {
        super();
    }
    override recreate(): Screen {
        return new Select(this.generation + 1);
    }
    override onUnloading(): void {
        log.push(`unload ${this.generation}`);
    }
    override onEntering(): void {
        log.push(`enter ${this.generation}`);
    }
    override onResuming(): void {
        log.push(`resume ${this.generation}`);
    }
}
class Loader extends Screen {}
class Player extends Screen {
    override readonly unloadsScreensBelow = true;
}

function makeStack(): ScreenStack {
    const game = {
        app: { screenLayer: new Container() },
        input: { pushKeyHandler: () => () => {} },
    } as unknown as Game;
    return new ScreenStack(game);
}

describe('ScreenStack unloading', () => {
    it('unloads rebuildable screens under gameplay and rebuilds them on return', () => {
        log.length = 0;
        const stack = makeStack();
        const menu = new Menu(), select = new Select(), loader = new Loader(), player = new Player();
        stack.push(menu);
        stack.push(select);
        stack.push(loader);
        stack.push(player);
        expect(select.destroyed).toBe(true);
        expect(log).toContain('unload 1');
        expect(stack.screens).toHaveLength(4);
        expect(stack.screens[0]).toBe(menu);
        expect(stack.screens[2]).toBe(loader);

        // Player exits to the loader; the loader exits to the rebuilt song select.
        stack.exit(player);
        expect(stack.current).toBe(loader);
        stack.exit(loader);
        const rebuilt = stack.current as Select;
        expect(rebuilt).toBeInstanceOf(Select);
        expect(rebuilt.generation).toBe(2);
        expect(log.at(-1)).toBe('enter 2');
        expect(rebuilt.parent).toBe(stack['game'].app.screenLayer);
    });

    it('finds an unloaded screen and makes it current again', () => {
        log.length = 0;
        const stack = makeStack();
        stack.push(new Menu());
        stack.push(new Select());
        stack.push(new Loader());
        stack.push(new Player());
        const found = stack.find(s => s instanceof Select);
        expect(found).toBeDefined();
        stack.makeCurrent(found!);
        expect(stack.current).toBeInstanceOf(Select);
        expect((stack.current as Select).generation).toBe(2);
        expect(log.at(-1)).toBe('enter 2');
    });

    it('exiting straight to the menu discards the stand-in', () => {
        const stack = makeStack();
        const menu = new Menu();
        stack.push(menu);
        stack.push(new Select());
        stack.push(new Loader());
        stack.push(new Player());
        stack.makeCurrent(menu);
        expect(stack.current).toBe(menu);
        expect(stack.screens).toHaveLength(1);
    });
});

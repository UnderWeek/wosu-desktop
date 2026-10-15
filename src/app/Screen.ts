import { Signal } from '../core/Signal';
import { UIComponent } from '../ui/UIComponent';
import type { Action } from '../input/bindings';
import type { Game } from './Game';

/**
 * A full-screen step of the game flow (menu, song select, gameplay...).
 * Lifecycle mirrors osu-framework's Screen:
 *
 *   push(B) while A is current:  A.onSuspending(B) → B.onEntering(A)
 *   B.exit():                     B.onExiting(A)   → A.onResuming(B)
 *
 * Transition methods start their own animations; `onExiting` returns how
 * long the stack should keep the screen alive before destroying it.
 */
export abstract class Screen extends UIComponent {
    game!: Game;
    stack!: ScreenStack;

    /** Hide the toolbar while this screen is current. */
    readonly hideToolbar: boolean = false;
    /** Show the menu cursor (gameplay draws its own). */
    readonly showMenuCursor: boolean = true;
    /** Hide the menu cursor after keyboard input until the mouse moves (lazer's song select). */
    readonly hideMenuCursorOnNonMouseInput: boolean = false;
    /** The screen itself takes clicks (full-screen hit area), not just its children. */
    readonly catchesClicks: boolean = false;
    /** Overlays (settings, listing) may be opened over this screen. */
    readonly allowOverlays: boolean = true;
    /** While this screen is in the stack, screens below it that can be rebuilt are unloaded (gameplay). */
    readonly unloadsScreensBelow: boolean = false;

    /**
     * A fresh copy of this screen, built when it becomes current again after
     * being unloaded; null (the default) keeps it loaded.
     */
    recreate(): Screen | null {
        return null;
    }

    /** Called just before an unload destroys this screen (cancel pending work). */
    onUnloading(): void {}

    private keyOff: (() => void) | null = null;

    get isCurrent(): boolean {
        return this.stack?.current === this;
    }

    /** Called once before first entering, with the game wired up. */
    load(): void {}

    onEntering(_previous: Screen | null): void {
        this.alpha = 0;
        this.fadeIn(300);
    }

    /** Return ms to wait before removal, or `false` to block the exit. */
    onExiting(_next: Screen | null): number | false {
        this.fadeOut(200);
        return 200;
    }

    onSuspending(_next: Screen): void {
        this.fadeOut(250);
    }

    onResuming(_previous: Screen): void {
        this.visible = true;
        this.fadeIn(300);
    }

    update(_dt: number): void {}

    /** Key routing while current; return true if consumed. */
    onKey(_e: KeyboardEvent, _action: Action | null): boolean {
        return false;
    }

    onKeyUp(_e: KeyboardEvent): void {}

    push(screen: Screen): void {
        this.stack.push(screen);
    }

    exit(): void {
        this.stack.exit(this);
    }

    /** @internal */
    attachKeys(off: () => void): void {
        this.keyOff?.();
        this.keyOff = off;
    }

    /** @internal */
    detachKeys(): void {
        this.keyOff?.();
        this.keyOff = null;
    }
}

/** Stands in for an unloaded screen until it is current again. */
class UnloadedScreen extends Screen {
    constructor(readonly rebuild: Screen) {
        super();
    }
}

export class ScreenStack {
    readonly screens: Screen[] = [];
    readonly changed = new Signal<[current: Screen | null, previous: Screen | null]>();
    private width = 0;
    private height = 0;

    constructor(private readonly game: Game) {}

    get current(): Screen | null {
        return this.screens[this.screens.length - 1] ?? null;
    }

    push(screen: Screen): void {
        const prev = this.current;
        screen.game = this.game;
        screen.stack = this;
        screen.load();
        screen.resize(this.width, this.height);
        this.game.app.screenLayer.addChild(screen);
        this.screens.push(screen);
        if (prev) {
            prev.detachKeys();
            prev.onSuspending(screen);
        }
        this.activate(screen);
        screen.onEntering(prev);
        this.changed.emit(screen, prev);
        if (screen.unloadsScreensBelow) this.unloadBelow(screen);
    }

    /** Destroy the rebuildable screens under `top`; each is built afresh when it is returned to. */
    private unloadBelow(top: Screen): void {
        const idx = this.screens.indexOf(top);
        for (let i = 0; i < idx; i++) {
            const s = this.screens[i];
            if (s instanceof UnloadedScreen) continue;
            const fresh = s.recreate();
            if (!fresh) continue;
            const stub = new UnloadedScreen(fresh);
            stub.game = this.game;
            stub.stack = this;
            this.screens[i] = stub;
            s.detachKeys();
            s.onUnloading();
            s.destroy({ children: true });
        }
    }

    /** Swap an unloaded stand-in for its rebuilt screen (it enters as if new). */
    private reload(stub: UnloadedScreen, from: Screen): Screen {
        const screen = stub.rebuild;
        screen.game = this.game;
        screen.stack = this;
        screen.load();
        screen.resize(this.width, this.height);
        const layer = this.game.app.screenLayer;
        layer.addChildAt(screen, from.parent === layer ? layer.getChildIndex(from) : layer.children.length);
        this.screens[this.screens.indexOf(stub)] = screen;
        stub.destroy();
        return screen;
    }

    /** Exit `screen` and everything above it. */
    exit(screen: Screen): void {
        const idx = this.screens.indexOf(screen);
        if (idx === -1) return;
        // Exit screens above first (without resume transitions in between).
        while (this.screens.length - 1 > idx) this.removeTop(true);
        if (this.screens.length <= 1) return; // never exit the root screen
        this.removeTop(false);
    }

    /** The first screen matching `test`, unloaded ones included (as their stand-in, fine for makeCurrent). */
    find(test: (screen: Screen) => boolean): Screen | undefined {
        return this.screens.find(s => test(s instanceof UnloadedScreen ? s.rebuild : s));
    }

    /** Make `screen` current by exiting everything above it. */
    makeCurrent(screen: Screen): void {
        const idx = this.screens.indexOf(screen);
        if (idx === -1 || idx === this.screens.length - 1) return;
        this.exit(this.screens[idx + 1]);
    }

    private removeTop(silent: boolean): void {
        const top = this.screens[this.screens.length - 1];
        const next = this.screens[this.screens.length - 2] ?? null;
        const wait = top.onExiting(next);
        if (wait === false && !silent) return;
        this.screens.pop();
        top.detachKeys();
        const ms = typeof wait === 'number' ? wait : 0;
        setTimeout(() => {
            if (!top.destroyed) top.destroy({ children: true });
        }, ms);
        top.eventMode = 'none';
        if (next && !silent) {
            if (next instanceof UnloadedScreen) {
                const screen = this.reload(next, top);
                this.activate(screen);
                screen.onEntering(top);
            } else {
                this.activate(next);
                next.onResuming(top);
            }
        }
        this.changed.emit(this.current, top);
    }

    private activate(screen: Screen): void {
        screen.eventMode = screen.catchesClicks ? 'static' : 'passive';
        screen.attachKeys(this.game.input.pushKeyHandler(
            (e, action) => screen.onKey(e, action),
            100,
            e => screen.onKeyUp(e),
        ));
    }

    resize(width: number, height: number): void {
        this.width = width;
        this.height = height;
        for (const s of this.screens) s.resize(width, height);
    }

    update(dt: number): void {
        // Suspended screens may still be fading; update all live ones.
        for (const s of this.screens) if (s.visible) s.update(dt);
    }
}

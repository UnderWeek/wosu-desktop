/**
 * The game's localStorage in ~/.wosu (desktop builds): a Storage backed by
 * the shell's file, installed over window.localStorage before anything
 * reads it. The first run copies what the old storage held (Electron's
 * Chromium profile), so settings carry over.
 */
import type { WosuNative } from './native';

class FileStorage implements Storage {
    private readonly map: Map<string, string>;

    constructor(private readonly store: NonNullable<WosuNative['localStore']>, initial: Record<string, string>) {
        this.map = new Map(Object.entries(initial));
    }

    get length(): number {
        return this.map.size;
    }

    key(index: number): string | null {
        return [...this.map.keys()][index] ?? null;
    }

    getItem(key: string): string | null {
        return this.map.get(String(key)) ?? null;
    }

    setItem(key: string, value: string): void {
        const k = String(key), v = String(value);
        this.map.set(k, v);
        this.store.set(k, v);
    }

    removeItem(key: string): void {
        this.map.delete(String(key));
        this.store.remove(String(key));
    }

    clear(): void {
        this.map.clear();
        this.store.replaceAll({});
    }
}

export function installFileLocalStorage(native: WosuNative | undefined): void {
    const store = native?.localStore;
    if (!store) return;
    const { exists, data } = store.snapshot();
    let initial = data;
    if (!exists) {
        // First run with the shared file: bring over what this runtime's own storage has.
        initial = {};
        try {
            const old = globalThis.localStorage;
            for (let i = 0; old && i < old.length; i++) {
                const k = old.key(i);
                if (k !== null) initial[k] = old.getItem(k) ?? '';
            }
        } catch { /* no old storage */ }
        store.replaceAll(initial);
    }
    const fileStorage = new FileStorage(store, initial);
    Object.defineProperty(globalThis, 'localStorage', { value: fileStorage, configurable: true });
}

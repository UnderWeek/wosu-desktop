import { lzmaCompress, lzmaDecompress } from '../../core/lzma';
import { md5Hex } from '../../core/md5';
import type { ModAcronym } from '../mods';
import type { GameplayMechanics } from '../scoring/mechanics';
import { BUTTON_BITS, type ReplayEvent } from './Replay';
import type { GameplayButton } from '../input/GameplayInput';

/**
 * Export to osu!'s .osr replay format (lazer's LegacyScoreEncoder, as a
 * stable-version replay so both clients open it): the score header, then
 * LZMA-compressed "w|x|y|z" frames. Custom mod settings (e.g. DT's speed)
 * have no place in the legacy format and are dropped.
 */

/** A stable client version (yyyymmdd); lazer reads anything below its own 30000000 range as stable. */
const OSR_VERSION = 20240411;

/** osu!stable's mod bits (lazer's LegacyMods). Daycore has none and exports as Half Time, like lazer. */
const LEGACY_MODS: Record<ModAcronym, number> = {
    NF: 1, EZ: 2, HD: 8, HR: 16, SD: 32, DT: 64, RX: 128, HT: 256, DC: 256,
    NC: 64 | 512, FL: 1024, AT: 2048, SO: 4096, AP: 8192, PF: 32 | 16384,
};

export function legacyModBits(mods: readonly ModAcronym[]): number {
    return mods.reduce((n, m) => n | (LEGACY_MODS[m] ?? 0), 0);
}

/** osu!'s ReplayButtonState: M1 = 1, M2 = 2, and K1 / K2 set their mouse bit too (5 / 10). */
function legacyButtons(buttons: number): number {
    let z = 0;
    if (buttons & BUTTON_BITS.M1) z |= 1;
    if (buttons & BUTTON_BITS.M2) z |= 2;
    if (buttons & BUTTON_BITS.K1) z |= 4 | 1;
    if (buttons & BUTTON_BITS.K2) z |= 8 | 2;
    return z;
}

/**
 * The replay as stable frames: every recorded frame from the song's start,
 * plus one at each press time with that button already down (a tap
 * shorter than a frame still shows up), in time order with whole-ms deltas.
 */
export function legacyFrames(events: readonly ReplayEvent[]): string {
    const frames: { time: number; x: number; y: number; z: number }[] = [];
    let held = 0;
    for (const e of events) {
        if (e.kind === 'frame') {
            held = e.buttons;
            frames.push({ time: e.time, x: e.x, y: e.y, z: legacyButtons(held) });
        } else if (e.kind === 'press') {
            frames.push({ time: e.time, x: e.x, y: e.y, z: legacyButtons(held | BUTTON_BITS[e.button]) });
        }
    }
    frames.sort((a, b) => a.time - b.time);
    // stable opens every replay with two placeholder frames (lazer skips them when reading).
    const parts = ['0|256|-500|0', '-1|256|-500|0'];
    let last = -1;
    for (const f of frames) {
        const t = Math.round(f.time);
        // Lead-in before the song starts: nothing to judge, and readers skip negative deltas.
        if (t < 0) continue;
        parts.push(`${t - last}|${+f.x.toFixed(4)}|${+f.y.toFixed(4)}|${f.z}`);
        last = t;
    }
    // The RNG seed frame stable writes last.
    parts.push('-12345|0|0|0');
    return parts.join(',') + ',';
}

export interface OsrScore {
    beatmapMd5: string;
    player: string;
    count300: number;
    count100: number;
    count50: number;
    countMiss: number;
    score: number;
    maxCombo: number;
    perfect: boolean;
    mods: readonly ModAcronym[];
    /** ms since the epoch. */
    date: number;
    events: readonly ReplayEvent[];
}

class OsrWriter {
    private readonly chunks: Uint8Array[] = [];

    private push(bytes: Uint8Array): void {
        this.chunks.push(bytes);
    }

    private sized(n: number, fn: (v: DataView) => void): void {
        const b = new Uint8Array(n);
        fn(new DataView(b.buffer));
        this.push(b);
    }

    byte(v: number): void {
        this.push(new Uint8Array([v & 0xff]));
    }

    short(v: number): void {
        this.sized(2, d => d.setUint16(0, Math.max(0, Math.min(0xffff, v)), true));
    }

    int(v: number): void {
        this.sized(4, d => d.setInt32(0, v, true));
    }

    long(v: bigint): void {
        this.sized(8, d => d.setBigInt64(0, v, true));
    }

    /** .NET BinaryWriter string as osu! writes it: 0x0b, ULEB128 length, UTF-8 (0x00 when empty). */
    string(s: string): void {
        if (!s) {
            this.byte(0);
            return;
        }
        const utf8 = new TextEncoder().encode(s);
        this.byte(0x0b);
        let n = utf8.length;
        do {
            let b = n & 0x7f;
            n >>>= 7;
            if (n) b |= 0x80;
            this.byte(b);
        } while (n);
        this.push(utf8);
    }

    bytes(data: Uint8Array): void {
        this.int(data.length);
        this.push(data);
    }

    finish(): Uint8Array<ArrayBuffer> {
        const out = new Uint8Array(this.chunks.reduce((n, c) => n + c.length, 0));
        let o = 0;
        for (const c of this.chunks) {
            out.set(c, o);
            o += c.length;
        }
        return out;
    }
}

/** .NET DateTime ticks (100 ns since 0001-01-01) for a JS time. */
function dotNetTicks(ms: number): bigint {
    return (BigInt(Math.round(ms)) + 62135596800000n) * 10000n;
}

export function encodeOsr(s: OsrScore): Uint8Array<ArrayBuffer> {
    const w = new OsrWriter();
    const mods = legacyModBits(s.mods);
    w.byte(0); // osu!standard
    w.int(OSR_VERSION);
    w.string(s.beatmapMd5);
    w.string(s.player);
    // stable's replay hash; nothing checks it for local replays, so any summary of the score does.
    w.string(md5Hex(`${s.count100 + s.count300}p${s.count50}o0o0t${s.countMiss}a${s.beatmapMd5}r${s.maxCombo}e${s.perfect}y${s.player}o${s.score}u${mods}`));
    w.short(s.count300);
    w.short(s.count100);
    w.short(s.count50);
    w.short(0); // gekis
    w.short(0); // katus
    w.short(s.countMiss);
    w.int(Math.min(2 ** 31 - 1, Math.round(s.score)));
    w.short(s.maxCombo);
    w.byte(s.perfect ? 1 : 0);
    w.int(mods);
    w.string(''); // life bar graph
    w.long(dotNetTicks(s.date));
    w.bytes(lzmaCompress(new TextEncoder().encode(legacyFrames(s.events))));
    w.long(0n); // online score id
    return w.finish();
}

// ---------------------------------------------------------------------------
// Reading .osr (osu!stable and lazer replays)
// ---------------------------------------------------------------------------

/** A decoded .osr: enough to find its beatmap and watch it. */
export interface OsrReplay extends OsrScore {
    mode: number;
    version: number;
    /** lazer writes versions from 30000000 up; anything lower came from stable. */
    mechanics: GameplayMechanics;
}

class OsrReader {
    private pos = 0;
    private readonly view: DataView;

    constructor(private readonly data: Uint8Array) {
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    }

    private need(n: number): void {
        if (this.pos + n > this.data.length) throw new Error('This .osr file is truncated');
    }

    byte(): number {
        this.need(1);
        return this.data[this.pos++];
    }

    short(): number {
        this.need(2);
        const v = this.view.getUint16(this.pos, true);
        this.pos += 2;
        return v;
    }

    int(): number {
        this.need(4);
        const v = this.view.getInt32(this.pos, true);
        this.pos += 4;
        return v;
    }

    long(): bigint {
        this.need(8);
        const v = this.view.getBigInt64(this.pos, true);
        this.pos += 8;
        return v;
    }

    string(): string {
        const tag = this.byte();
        if (tag === 0) return '';
        if (tag !== 0x0b) throw new Error('Not an osu! replay (.osr)');
        let n = 0, shift = 0, b: number;
        do {
            b = this.byte();
            n |= (b & 0x7f) << shift;
            shift += 7;
        } while (b & 0x80);
        this.need(n);
        const s = new TextDecoder().decode(this.data.subarray(this.pos, this.pos + n));
        this.pos += n;
        return s;
    }

    bytes(n: number): Uint8Array {
        this.need(n);
        const out = this.data.subarray(this.pos, this.pos + n);
        this.pos += n;
        return out;
    }
}

/** Legacy mod bits back to wosu!'s mods (the ones it has). */
export function modsFromLegacyBits(bits: number): ModAcronym[] {
    const out: ModAcronym[] = [];
    const has = (b: number) => (bits & b) === b;
    if (has(1)) out.push('NF');
    if (has(2)) out.push('EZ');
    if (has(8)) out.push('HD');
    if (has(16)) out.push('HR');
    if (has(16384)) out.push('PF');
    else if (has(32)) out.push('SD');
    if (has(512)) out.push('NC');
    else if (has(64)) out.push('DT');
    if (has(128)) out.push('RX');
    if (has(256)) out.push('HT');
    if (has(1024)) out.push('FL');
    if (has(4096)) out.push('SO');
    if (has(8192)) out.push('AP');
    return out;
}

/**
 * "w|x|y|z" frames to wosu! events: held buttons per frame, plus a press
 * wherever a button goes down (K1/K2 also set their mouse bit in osu!'s
 * format; a key wins over the mouse button it shadows).
 */
export function framesToEvents(text: string): ReplayEvent[] {
    const events: ReplayEvent[] = [];
    let time = 0;
    let held = 0;
    let first = true;
    for (const part of text.split(',')) {
        if (!part) continue;
        const [ws, xs, ys, zs] = part.split('|');
        const w = Number(ws), x = Number(xs), y = Number(ys), z = Number(zs) | 0;
        if (!Number.isFinite(w) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (w === -12345) continue; // RNG seed
        // Placeholder frames still move the clock (stable writes deltas 0 and -1),
        // lazer's LegacyScoreDecoder skips only the frames themselves.
        time += w;
        if (first && x === 256 && y === -500) continue;
        first = false;
        let buttons = 0;
        if (z & 4) buttons |= BUTTON_BITS.K1;
        else if (z & 1) buttons |= BUTTON_BITS.M1;
        if (z & 8) buttons |= BUTTON_BITS.K2;
        else if (z & 2) buttons |= BUTTON_BITS.M2;
        const down = buttons & ~held;
        for (const b of ['K1', 'K2', 'M1', 'M2'] as GameplayButton[]) {
            if (down & BUTTON_BITS[b]) events.push({ kind: 'press', time, x, y, button: b });
        }
        held = buttons;
        events.push({ kind: 'frame', time, x, y, buttons });
    }
    return events;
}

/** .NET ticks to ms since the epoch. */
function fromDotNetTicks(ticks: bigint): number {
    return Number(ticks / 10000n - 62135596800000n);
}

export function decodeOsr(data: Uint8Array): OsrReplay {
    const r = new OsrReader(data);
    const mode = r.byte();
    if (mode > 3) throw new Error('Not an osu! replay (.osr)');
    const version = r.int();
    const beatmapMd5 = r.string();
    const player = r.string();
    r.string(); // replay hash
    const count300 = r.short();
    const count100 = r.short();
    const count50 = r.short();
    r.short(); // gekis
    r.short(); // katus
    const countMiss = r.short();
    const score = r.int();
    const maxCombo = r.short();
    const perfect = r.byte() !== 0;
    const modBits = r.int();
    r.string(); // life bar
    const date = fromDotNetTicks(r.long());
    const length = r.int();
    const frames = length > 0 ? new TextDecoder().decode(lzmaDecompress(r.bytes(length))) : '';
    return {
        mode,
        version,
        mechanics: version >= 30000000 ? 'lazer' : 'stable',
        beatmapMd5,
        player,
        count300,
        count100,
        count50,
        countMiss,
        score,
        maxCombo,
        perfect,
        mods: modsFromLegacyBits(modBits),
        date,
        events: framesToEvents(frames),
    };
}

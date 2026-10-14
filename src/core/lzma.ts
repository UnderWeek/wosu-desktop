/**
 * A minimal LZMA ("alone" / .lzma format) encoder, enough for osu!'s .osr
 * replays. It codes every byte as a literal with LZMA's adaptive range
 * coder (no match finder), so the output is a valid stream any LZMA
 * decoder reads (osu!stable, lazer, xz), compressing text like replay
 * frames to roughly half, without pulling in a full LZMA library.
 */

// lc = 3, lp = 0, pb = 2: the LZMA SDK defaults osu! uses too.
const LC = 3;
const PB = 2;
const PROPS = (PB * 5 + 0) * 9 + LC;
const DICT_SIZE = 1 << 21;
const PROB_INIT = 1024;
const TOP = 2 ** 24;

class RangeEncoder {
    private low = 0;
    private range = 0xffffffff;
    private cache = 0;
    private cacheSize = 1;
    private buf: Uint8Array;
    length = 0;

    constructor(capacity: number) {
        this.buf = new Uint8Array(Math.max(64, capacity));
    }

    private write(b: number): void {
        if (this.length === this.buf.length) {
            const next = new Uint8Array(this.buf.length * 2);
            next.set(this.buf);
            this.buf = next;
        }
        this.buf[this.length++] = b;
    }

    private shiftLow(): void {
        // `low` is kept below 2^33: bit 32 is the carry into the cached byte.
        if (this.low < 0xff000000 || this.low >= 2 ** 32) {
            const carry = this.low >= 2 ** 32 ? 1 : 0;
            let temp = this.cache;
            do {
                this.write((temp + carry) & 0xff);
                temp = 0xff;
            } while (--this.cacheSize !== 0);
            this.cache = (this.low >>> 24) & 0xff;
        }
        this.cacheSize++;
        this.low = (this.low % TOP) * 256;
    }

    bit(probs: Uint16Array, i: number, bit: number): void {
        const p = probs[i];
        const bound = (this.range >>> 11) * p;
        if (bit === 0) {
            this.range = bound;
            probs[i] = p + ((2048 - p) >> 5);
        } else {
            this.low += bound;
            this.range -= bound;
            probs[i] = p - (p >> 5);
        }
        while (this.range < TOP) {
            this.range = (this.range * 256) >>> 0;
            this.shiftLow();
        }
    }

    finish(): Uint8Array {
        for (let i = 0; i < 5; i++) this.shiftLow();
        return this.buf.subarray(0, this.length);
    }
}

/** Compress to the 13-byte-header .lzma format (props, dictionary size, uncompressed size). */
export function lzmaCompress(data: Uint8Array): Uint8Array {
    const rc = new RangeEncoder(data.length + 16);
    // Only literals are coded, so the LZMA state stays 0 and only its is-match bits are used.
    const isMatch = new Uint16Array(1 << PB).fill(PROB_INIT);
    const literals = new Uint16Array(0x300 << LC).fill(PROB_INIT);
    let prev = 0;
    for (let pos = 0; pos < data.length; pos++) {
        rc.bit(isMatch, pos & ((1 << PB) - 1), 0);
        const base = 0x300 * (prev >> (8 - LC));
        const byte = data[pos];
        let symbol = 1;
        for (let i = 7; i >= 0; i--) {
            const bit = (byte >> i) & 1;
            rc.bit(literals, base + symbol, bit);
            symbol = (symbol << 1) | bit;
        }
        prev = byte;
    }
    const body = rc.finish();
    const out = new Uint8Array(13 + body.length);
    const view = new DataView(out.buffer);
    out[0] = PROPS;
    view.setUint32(1, DICT_SIZE, true);
    view.setBigUint64(5, BigInt(data.length), true);
    out.set(body, 13);
    return out;
}

// ---------------------------------------------------------------------------
// Decoder (LZMA "alone" format, as in .osr replays from osu!stable/lazer)
// ---------------------------------------------------------------------------

class RangeDecoder {
    private range = 0xffffffff;
    private code = 0;
    private pos: number;

    constructor(private readonly src: Uint8Array, start: number) {
        if (src[start] !== 0) throw new Error('corrupt LZMA stream');
        this.pos = start + 1;
        for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.byte()) >>> 0;
    }

    private byte(): number {
        if (this.pos >= this.src.length) throw new Error('truncated LZMA stream');
        return this.src[this.pos++];
    }

    private normalize(): void {
        if (this.range < TOP) {
            this.range = (this.range * 256) >>> 0;
            this.code = ((this.code << 8) | this.byte()) >>> 0;
        }
    }

    bit(probs: Uint16Array, i: number): number {
        const p = probs[i];
        const bound = (this.range >>> 11) * p;
        let b: number;
        if (this.code < bound) {
            this.range = bound;
            probs[i] = p + ((2048 - p) >>> 5);
            b = 0;
        } else {
            this.range -= bound;
            this.code -= bound;
            probs[i] = p - (p >>> 5);
            b = 1;
        }
        this.normalize();
        return b;
    }

    direct(n: number): number {
        let res = 0;
        for (let i = 0; i < n; i++) {
            this.range >>>= 1;
            let b = 0;
            if (this.code >= this.range) {
                this.code -= this.range;
                b = 1;
            }
            res = ((res << 1) | b) >>> 0;
            this.normalize();
        }
        return res;
    }

    tree(probs: Uint16Array, offset: number, bits: number): number {
        let m = 1;
        for (let i = 0; i < bits; i++) m = (m << 1) + this.bit(probs, offset + m);
        return m - (1 << bits);
    }

    reverse(probs: Uint16Array, offset: number, bits: number): number {
        let m = 1, sym = 0;
        for (let i = 0; i < bits; i++) {
            const b = this.bit(probs, offset + m);
            m = (m << 1) + b;
            sym |= b << i;
        }
        return sym;
    }
}

function probs(n: number): Uint16Array {
    return new Uint16Array(n).fill(PROB_INIT);
}

class LenDecoder {
    private readonly choice = probs(2);
    private readonly low: Uint16Array;
    private readonly mid: Uint16Array;
    private readonly high = probs(256);

    constructor(posStates: number) {
        this.low = probs(posStates << 3);
        this.mid = probs(posStates << 3);
    }

    decode(rc: RangeDecoder, posState: number): number {
        if (rc.bit(this.choice, 0) === 0) return rc.tree(this.low, posState << 3, 3);
        if (rc.bit(this.choice, 1) === 0) return 8 + rc.tree(this.mid, posState << 3, 3);
        return 16 + rc.tree(this.high, 0, 8);
    }
}

/** Decompress an LZMA "alone" stream (13-byte header: props, dictionary size, size or -1). */
export function lzmaDecompress(data: Uint8Array): Uint8Array {
    if (data.length < 13) throw new Error('truncated LZMA stream');
    let d = data[0];
    if (d >= 9 * 5 * 5) throw new Error('bad LZMA properties');
    const lc = d % 9;
    d = (d / 9) | 0;
    const lp = d % 5;
    const pb = (d / 5) | 0;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const lo = view.getUint32(5, true), hi = view.getUint32(9, true);
    const known = !(lo === 0xffffffff && hi === 0xffffffff);
    const size = known ? hi * 2 ** 32 + lo : -1;
    if (known && size > 512 * 1024 * 1024) throw new Error('LZMA stream too large');

    const rc = new RangeDecoder(data, 13);
    let out = new Uint8Array(known ? size : Math.max(1024, data.length * 4));
    let n = 0;
    const put = (b: number) => {
        if (n === out.length) {
            const bigger = new Uint8Array(out.length * 2);
            bigger.set(out);
            out = bigger;
        }
        out[n++] = b;
    };

    const posStates = 1 << pb;
    const pbMask = posStates - 1, lpMask = (1 << lp) - 1;
    const literal = probs(0x300 << (lc + lp));
    const isMatch = probs(12 << 4), isRep = probs(12), isRepG0 = probs(12), isRepG1 = probs(12), isRepG2 = probs(12);
    const isRep0Long = probs(12 << 4);
    const posSlot = probs(4 << 6);
    const posDecoders = probs(1 + 114);
    const align = probs(16);
    const lenDec = new LenDecoder(posStates);
    const repLenDec = new LenDecoder(posStates);
    let state = 0, rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0;

    while (!known || n < size) {
        const posState = n & pbMask;
        if (rc.bit(isMatch, (state << 4) + posState) === 0) {
            const prev = n > 0 ? out[n - 1] : 0;
            const base = 0x300 * (((n & lpMask) << lc) + (prev >>> (8 - lc)));
            let sym = 1;
            if (state >= 7) {
                // After a match: the byte at rep0 steers the first bits.
                let matchByte = out[n - rep0 - 1];
                do {
                    const matchBit = (matchByte >>> 7) & 1;
                    matchByte <<= 1;
                    const b = rc.bit(literal, base + ((1 + matchBit) << 8) + sym);
                    sym = (sym << 1) | b;
                    if (matchBit !== b) break;
                } while (sym < 0x100);
            }
            while (sym < 0x100) sym = (sym << 1) | rc.bit(literal, base + sym);
            put(sym & 0xff);
            state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
            continue;
        }
        let len: number;
        if (rc.bit(isRep, state) !== 0) {
            if (n === 0) throw new Error('corrupt LZMA stream');
            if (rc.bit(isRepG0, state) === 0) {
                if (rc.bit(isRep0Long, (state << 4) + posState) === 0) {
                    // Short rep: one byte from rep0.
                    state = state < 7 ? 9 : 11;
                    put(out[n - rep0 - 1]);
                    continue;
                }
            } else {
                let dist: number;
                if (rc.bit(isRepG1, state) === 0) {
                    dist = rep1;
                } else {
                    if (rc.bit(isRepG2, state) === 0) {
                        dist = rep2;
                    } else {
                        dist = rep3;
                        rep3 = rep2;
                    }
                    rep2 = rep1;
                }
                rep1 = rep0;
                rep0 = dist;
            }
            len = repLenDec.decode(rc, posState);
            state = state < 7 ? 8 : 11;
        } else {
            rep3 = rep2;
            rep2 = rep1;
            rep1 = rep0;
            len = lenDec.decode(rc, posState);
            state = state < 7 ? 7 : 10;
            const lenState = len < 3 ? len : 3;
            const slot = rc.tree(posSlot, lenState << 6, 6);
            if (slot < 4) {
                rep0 = slot;
            } else {
                const direct = (slot >>> 1) - 1;
                let dist = ((2 | (slot & 1)) << direct) >>> 0;
                if (slot < 14) {
                    dist += rc.reverse(posDecoders, dist - slot, direct);
                } else {
                    dist += rc.direct(direct - 4) * 16;
                    dist += rc.reverse(align, 0, 4);
                }
                rep0 = dist >>> 0;
            }
            if (rep0 === 0xffffffff) break; // end marker
        }
        len += 2;
        if (rep0 >= n) throw new Error('corrupt LZMA stream');
        for (let i = 0; i < len && (!known || n < size); i++) put(out[n - rep0 - 1]);
    }
    return n === out.length ? out : out.slice(0, n);
}

import { execFileSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { lzmaCompress, lzmaDecompress } from '../src/core/lzma';

function sampleFrames(n: number): string {
    const parts: string[] = [];
    let x = 256, y = 192;
    for (let i = 0; i < n; i++) {
        x += Math.round(Math.sin(i / 7) * 30);
        y += Math.round(Math.cos(i / 11) * 20);
        parts.push(`16|${x}.${i % 97}|${y}.${i % 13}|${i % 5 === 0 ? 5 : 0}`);
    }
    return parts.join(',') + ',';
}

describe('lzmaDecompress', () => {
    test('round-trips our own encoder', () => {
        const text = new TextEncoder().encode(sampleFrames(3000));
        expect(lzmaDecompress(lzmaCompress(text))).toEqual(text);
    });

    // Real match-heavy streams from the LZMA SDK's encoder (xz), when available.
    let hasXz = true;
    try { execFileSync('xz', ['--version']); } catch { hasXz = false; }
    test.skipIf(!hasXz)('decodes xz --format=lzma output (known and unknown size)', () => {
        for (const n of [1, 50, 4000]) {
            const text = new TextEncoder().encode(sampleFrames(n) + 'repeat '.repeat(n));
            const packed = new Uint8Array(execFileSync('xz', ['--format=lzma', '-9', '-c'], { input: text }));
            expect(lzmaDecompress(packed)).toEqual(text);
        }
    }, 30_000);
});

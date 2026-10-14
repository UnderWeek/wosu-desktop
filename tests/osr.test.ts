import { expect, test } from 'vitest';
import { decodeOsr, encodeOsr } from '../src/gameplay/replay/osr';

test('decodeOsr reads what encodeOsr writes', () => {
    const events = [
        { kind: 'frame' as const, time: 0, x: 100, y: 100, buttons: 0 },
        { kind: 'press' as const, time: 500, x: 120, y: 110, button: 'K1' as const },
        { kind: 'frame' as const, time: 500, x: 120, y: 110, buttons: 1 },
        { kind: 'frame' as const, time: 560, x: 130, y: 115, buttons: 0 },
    ];
    const osr = encodeOsr({ beatmapMd5: 'abc', player: 'me', count300: 5, count100: 1, count50: 0, countMiss: 2, score: 12345, maxCombo: 7, perfect: false, mods: ['HD', 'DT'], date: Date.UTC(2026, 0, 2), events });
    const r = decodeOsr(osr);
    expect([r.beatmapMd5, r.player, r.count300, r.countMiss, r.score, r.maxCombo, r.date]).toEqual(['abc', 'me', 5, 2, 12345, 7, Date.UTC(2026, 0, 2)]);
    expect([...r.mods].sort()).toEqual(['DT', 'HD']);
    expect(r.events.filter(e => e.kind === 'press')).toEqual([{ kind: 'press', time: 500, x: 120, y: 110, button: 'K1' }]);
});

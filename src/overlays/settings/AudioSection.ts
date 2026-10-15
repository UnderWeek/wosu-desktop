import type { Game } from '../../app/Game';
import { buttonRow, checkboxRow, ms, pct, sliderRow } from './rows';
import type { SectionDef } from './types';

export function audioSection(game: Game): SectionDef {
    const s = game.settings;
    return {
        id: 'audio',
        title: 'Audio',
        icon: 'volumeHigh',
        subsections: [
            {
                title: 'Volume',
                rows: [
                    sliderRow('Master', s.masterVolume, pct, { keywords: 'volume' }),
                    sliderRow('Music', s.musicVolume, pct, { keywords: 'volume song' }),
                    sliderRow('Effects', s.effectsVolume, pct, { keywords: 'volume hitsounds sfx' }),
                ],
            },
            {
                title: 'Offset',
                rows: [
                    sliderRow('Audio offset', s.audioOffset, ms, {
                        description: 'Positive values delay hit timing to compensate for audio latency. If every map feels early, increase it; if late, decrease it.',
                        keywords: 'latency sync delay',
                    }),
                    buttonRow('Calibrate using last play', () => {
                        const t = game.lastPlayTiming.value;
                        if (!t) {
                            game.notifications.info('Play a map first: calibration uses your hits from the last play.');
                            return;
                        }
                        s.audioOffset.value += Math.round(t.meanMs);
                        game.lastPlayTiming.value = null;
                        game.notifications.info(`Audio offset: ${s.audioOffset.value > 0 ? '+' : ''}${s.audioOffset.value} ms`);
                    }, { keywords: 'latency sync delay calibrate' }),
                ],
            },
            {
                title: 'Sounds',
                rows: [
                    checkboxRow('Interface sounds', s.uiSounds, { keywords: 'ui click hover' }),
                    checkboxRow('Menu music', s.menuMusic, { keywords: 'background song' }),
                    checkboxRow('Beatmap hitsounds', s.beatmapHitsounds, { keywords: 'whistle clap finish' }),
                ],
            },
        ],
    };
}

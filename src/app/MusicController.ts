import { audioLog } from '../debug/AudioDebug';
import { Bindable } from '../core/Bindable';
import { Signal } from '../core/Signal';
import type { AudioEngine } from '../audio/AudioEngine';
import { MusicTrack } from '../audio/MusicTrack';
import type { PreviewPlayer } from '../audio/PreviewPlayer';
import type { BeatmapLibrary, LibrarySet } from '../beatmap/Library';
import { buildControlPointTimeline } from '../beatmap/controlPoints';
import type { ControlPointTimeline } from '../beatmap/types';
import { coverUrl, previewUrl, type OnlineSet } from '../online/providers';

export type NowPlaying =
    | { kind: 'library'; set: LibrarySet; title: string; artist: string }
    | { kind: 'online'; sid: number; title: string; artist: string; cover: string };

export interface BeatState {
    /** ms per beat, or 0 when unknown (previews). */
    beatLength: number;
    /** 0..1 progress through the current beat. */
    phase: number;
    /** Index of the current beat. */
    beatIndex: number;
    kiai: boolean;
}

/**
 * Menu music, osu!-style: plays full songs from the library (random
 * order, with history for "previous"), falls back to online preview clips
 * when the library is empty, and lends its decoded track to gameplay so a
 * song is never decoded twice.
 */
export class MusicController {
    readonly current = new Bindable<NowPlaying | null>(null);
    readonly trackChanged = new Signal<[NowPlaying | null]>();
    readonly playingState = new Bindable(false);

    private track: MusicTrack | null = null;
    private trackSetKey: string | null = null;
    private timeline: ControlPointTimeline | null = null;
    private history: string[] = [];
    private historyPos = -1;
    private loadSeq = 0;
    private lent = false;
    /** In song select the selected song loops from its preview point. */
    loopFromPreview = false;
    enabled = true;
    /**
     * Whether music carries on after a beatmap-listing preview ends. False
     * when the preview interrupted paused music (it stays paused).
     */
    resumeAfterPreview = true;

    constructor(
        private readonly engine: AudioEngine,
        private readonly preview: PreviewPlayer,
        private readonly library: BeatmapLibrary,
    ) {
        preview.ended.add(() => {
            if (this.current.value?.kind !== 'online') return;
            // A listing preview started while the music was paused leaves it paused.
            if (this.enabled && !this.loopFromPreview && this.resumeAfterPreview) void this.next();
            else this.playingState.value = false;
        });
        library.changed.add(() => {
            // The playing song's set was deleted: move on, like lazer.
            const now = this.current.value;
            if (now?.kind !== 'library' || this.lent || library.get(now.set.key)) return;
            // Song select moves its selection to a neighbour and plays that.
            if (this.loopFromPreview && library.sets.length > 0) return;
            if (this.enabled) {
                void this.next();
            } else {
                ++this.loadSeq;
                this.stopTrack(300);
                this.timeline = null;
                this.setNow(null);
                this.playingState.value = false;
            }
        });
    }

    get isPlaying(): boolean {
        if (this.track && !this.lent) return this.track.isPlaying;
        return this.preview.playing;
    }

    /** Current position in ms (library tracks only). */
    get position(): number {
        return this.track && !this.lent ? this.track.currentTime : this.preview.currentTime;
    }

    get duration(): number {
        return this.track && !this.lent ? this.track.duration : this.preview.duration;
    }

    get currentTrack(): MusicTrack | null {
        return this.lent ? null : this.track;
    }

    /** Play a library set. `fromPreview` starts at the map's preview point. */
    async playSet(set: LibrarySet, opts: { fromPreview?: boolean; restart?: boolean; fadeInMs?: number } = {}): Promise<void> {
        this.resumeAfterPreview = true;
        const now = this.current.value;
        if (!opts.restart && now?.kind === 'library' && now.set.key === set.key && this.track && this.trackSetKey === set.key && !this.lent) {
            if (!this.track.isPlaying) this.track.play();
            this.playingState.value = true;
            return;
        }
        const seq = ++this.loadSeq;
        audioLog('music.playSet', `${set.title.slice(0, 40)} seq=${seq} fromPreview=${!!opts.fromPreview}`);
        this.preview.stop(300);
        this.pushHistory(set.key);
        this.setNow({ kind: 'library', set, title: set.title, artist: set.artist });
        let streamUrl: string | null = null;
        try {
            const archive = await this.library.openArchive(set.key);
            const file = archive.findAudio(set.audioFile);
            if (!file) throw new Error('no audio file');
            const bytes = await archive.readBytes(file);
            if (seq !== this.loadSeq) return;
            const fadeInMs = opts.fadeInMs ?? (opts.fromPreview ? 600 : 0);
            // Decoding a whole song takes 0.5-5 s (more on a hot laptop):
            // stream it right away and switch to the decoded track (which
            // gameplay, beat sync and pitch control need) once it is ready.
            this.stopTrack(250);
            this.timeline = null;
            streamUrl = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>]));
            this.streaming = { seq, url: streamUrl, pausedAt: null };
            const startAt = opts.fromPreview ? (set.previewTime > 0 ? set.previewTime : -0.4) : 0;
            void this.preview.play(streamUrl, { fadeInMs, startAt }).catch(() => {});
            this.playingState.value = true;
            this.loadTimeline(set, seq);

            const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
            const track = await this.decodeLatest(seq, buf, file);
            if (!track) {
                audioLog('music.decodeSkipped', `seq=${seq} current=${this.loadSeq}`);
                return;
            }
            if (seq !== this.loadSeq) {
                audioLog('music.decodeStale', `#${track.debugId} seq=${seq} current=${this.loadSeq}`);
                track.dispose();
                return;
            }
            audioLog('music.handoff', `#${track.debugId} seq=${seq} streamPlaying=${this.preview.playing}`);
            // Hand over at the streamed position (a short crossfade hides the seam).
            const stream = this.streaming;
            this.streaming = null;
            const streamed = this.preview.playing ? this.preview.currentTime : null;
            const pausedAt = stream?.pausedAt ?? null;
            this.replaceTrack(track, set.key);
            this.loadTimeline(set, seq);
            if (pausedAt !== null) {
                this.preview.stop(0);
                track.seek(pausedAt);
                this.playingState.value = false;
                return;
            }
            const start = streamed ?? (opts.fromPreview ? Math.max(0, set.previewTime > 0 ? set.previewTime : track.duration * 0.4) : 0);
            track.playFrom(Math.min(start, Math.max(0, track.duration - 1)), streamed !== null ? 80 : fadeInMs);
            this.preview.stop(80);
            this.playingState.value = true;
        } catch (e) {
            console.warn('music: failed to play set', set.key, e);
            if (seq === this.loadSeq) {
                this.playingState.value = false;
                this.streaming = null;
            }
        } finally {
            const url = streamUrl;
            // The element may still be fading out from it.
            if (url) setTimeout(() => URL.revokeObjectURL(url), 2000);
        }
    }

    /** A library song playing from its file while its full decode runs. */
    private streaming: { seq: number; url: string; pausedAt: number | null } | null = null;
    private decoding: Promise<unknown> = Promise.resolve();

    /**
     * One decode at a time, and only for the newest request: scrolling
     * through song select must not queue up a decode per song passed
     * (they all compete for the same cores and the wanted one comes last).
     */
    private async decodeLatest(seq: number, buf: ArrayBuffer, file: string): Promise<MusicTrack | null> {
        const before = this.decoding;
        let release!: () => void;
        this.decoding = new Promise<void>(r => (release = r));
        try {
            await before;
            if (seq !== this.loadSeq) return null;
            return await MusicTrack.decode(this.engine, buf, file);
        } finally {
            release();
        }
    }

    /** Play an online preview clip (beatmap listing, empty-library menu). */
    async playOnline(set: Pick<OnlineSet, 'sid' | 'title' | 'artist'>): Promise<void> {
        const seq = ++this.loadSeq;
        this.stopTrack(300);
        this.timeline = null;
        this.setNow({ kind: 'online', sid: set.sid, title: set.title, artist: set.artist, cover: coverUrl(set.sid) });
        try {
            await this.preview.play(previewUrl(set.sid), { fadeInMs: 300 });
            this.playingState.value = true;
        } catch {
            // Superseded (a newer request owns the state) or blocked.
            if (seq === this.loadSeq) this.playingState.value = false;
        }
    }

    stopPreview(): void {
        this.preview.stop(300);
        if (this.current.value?.kind === 'online') this.playingState.value = false;
    }

    async next(): Promise<void> {
        if (this.historyPos < this.history.length - 1) {
            this.historyPos++;
            const set = this.library.get(this.history[this.historyPos]);
            if (set) return this.playSet(set, { restart: true });
        }
        return this.playRandom();
    }

    async prev(): Promise<void> {
        // Like osu!: restart if we're a few seconds in, else go back.
        if (this.track && !this.lent && this.track.currentTime > 4000) {
            this.track.playFrom(0);
            return;
        }
        if (this.historyPos > 0) {
            this.historyPos--;
            const set = this.library.get(this.history[this.historyPos]);
            if (set) {
                this.historyPos--; // playSet pushes it back
                return this.playSet(set, { restart: true });
            }
        }
        if (this.track && !this.lent) this.track.playFrom(0);
    }

    async playRandom(): Promise<void> {
        const sets = this.library.sets;
        if (sets.length > 0) {
            const currentKey = this.current.value?.kind === 'library' ? this.current.value.set.key : null;
            let pick = sets[Math.floor(Math.random() * sets.length)];
            if (sets.length > 1 && pick.key === currentKey) pick = sets[(sets.indexOf(pick) + 1) % sets.length];
            return this.playSet(pick, { restart: true });
        }
        // Empty library: stay silent (the first-launch download starts music).
    }

    togglePause(): void {
        this.resumeAfterPreview = true;
        const s = this.streaming;
        if (s && s.seq === this.loadSeq && !this.track) {
            // Still streaming: pause by remembering where; the decoded track takes over there.
            if (s.pausedAt === null) {
                s.pausedAt = this.preview.currentTime;
                this.preview.stop(150);
                this.playingState.value = false;
            } else {
                const at = s.pausedAt;
                s.pausedAt = null;
                void this.preview.play(s.url, { fadeInMs: 150, startAt: at }).catch(() => {});
                this.playingState.value = true;
            }
            return;
        }
        if (this.track && !this.lent) {
            if (this.track.isPlaying) this.track.pause();
            else this.track.play();
            this.playingState.value = this.track.isPlaying;
            return;
        }
        if (this.current.value?.kind === 'online') {
            if (this.preview.playing) this.stopPreview();
            else void this.playOnline(this.current.value);
        }
    }

    seek(ms: number): void {
        if (this.track && !this.lent) this.track.seek(ms);
    }

    /** Pause, and drop any song still loading so it can't start later (gameplay is taking over). */
    pause(): void {
        ++this.loadSeq;
        audioLog('music.pause', `seq=${this.loadSeq} track=${this.track ? '#' + this.track.debugId : '-'} lent=${this.lent} preview=${this.preview.playing}`);
        if (this.track && !this.lent && this.track.isPlaying) this.track.pause();
        this.preview.stop(200);
        this.playingState.value = false;
    }

    /**
     * Hand the decoded track for `setKey` to gameplay. Returns null when a
     * different (or no) track is loaded. Call `reclaim` afterwards.
     */
    lend(setKey: string): MusicTrack | null {
        // A song still loading (quick re-selection) must not start over gameplay.
        ++this.loadSeq;
        audioLog('music.lend', `key match=${this.trackSetKey === setKey} track=${this.track ? '#' + this.track.debugId : '-'} preview=${this.preview.playing}`);
        if (!this.track || this.trackSetKey !== setKey) return null;
        this.lent = true;
        this.track.ended.clear();
        this.track.loop = false;
        return this.track;
    }

    /** Take the track back after gameplay (or accept the one it decoded). */
    reclaim(track: MusicTrack | null, setKey: string | null): void {
        audioLog('music.reclaim', `track=${track ? '#' + track.debugId + ' playing=' + track.isPlaying : '-'}`);
        this.lent = false;
        if (track && setKey) {
            if (track !== this.track) this.replaceTrack(track, setKey);
            else this.attachEnded(track);
            track.setRate(1, true).catch(() => {});
        }
    }

    /** One line for the audio debugger. */
    debugState(): string {
        const now = this.current.value;
        return `music: ${now ? now.kind + ' ' + now.title.slice(0, 40) : 'none'} | track=${this.track ? '#' + this.track.debugId + (this.track.isPlaying ? ' PLAYING' : ' paused') : '-'} lent=${this.lent} ` +
            `streaming=${this.streaming ? (this.streaming.seq === this.loadSeq ? 'yes' : 'stale') : 'no'} preview=${this.preview.playing ? 'PLAYING t=' + (this.preview.currentTime / 1000).toFixed(1) : 'off'} seq=${this.loadSeq}`;
    }

    /** Beat phase for visual sync (logo pulse, kiai flashes). */
    beat(): BeatState {
        const t = this.track;
        if (!t || this.lent || !this.timeline || !t.isPlaying) return { beatLength: 0, phase: 0, beatIndex: 0, kiai: false };
        const time = t.currentTime;
        const cp = this.timeline.at(time);
        const uninheritedStart = findTimingStart(this.timeline, time);
        const since = time - uninheritedStart;
        const beatLength = cp.beatLength > 0 ? cp.beatLength : 500;
        const idx = Math.floor(since / beatLength);
        return { beatLength, phase: (since - idx * beatLength) / beatLength, beatIndex: idx, kiai: cp.kiai };
    }

    private loadTimeline(set: LibrarySet, seq: number): void {
        const diff = set.difficulties[set.difficulties.length - 1];
        if (!diff) return;
        this.library.loadBeatmap(set.key, diff.file).then(data => {
            if (seq !== this.loadSeq) return;
            this.timeline = buildControlPointTimeline(data.timingPoints, data.general.sampleSet);
        }).catch(() => (this.timeline = null));
    }

    private setNow(n: NowPlaying | null): void {
        this.current.value = n;
        this.trackChanged.emit(n);
    }

    private pushHistory(key: string): void {
        if (this.history[this.historyPos] === key) return;
        this.history.splice(this.historyPos + 1);
        this.history.push(key);
        if (this.history.length > 100) this.history.shift();
        this.historyPos = this.history.length - 1;
    }

    private replaceTrack(track: MusicTrack, key: string): void {
        if (this.track && this.track !== track && !this.lent) {
            const old = this.track;
            old.fadeTo(0, 250).then(() => old.dispose());
        }
        this.track = track;
        this.trackSetKey = key;
        this.lent = false;
        this.attachEnded(track);
    }

    private attachEnded(track: MusicTrack): void {
        track.ended.clear();
        track.ended.add(() => {
            if (track !== this.track || this.lent) return;
            if (this.loopFromPreview && this.current.value?.kind === 'library') {
                const set = this.current.value.set;
                track.playFrom(Math.max(0, set.previewTime), 600);
            } else if (this.enabled) {
                void this.next();
            } else {
                this.playingState.value = false;
            }
        });
    }

    private stopTrack(fadeMs: number): void {
        if (!this.track || this.lent) return;
        audioLog('music.stopTrack', `#${this.track.debugId} fade ${fadeMs}`);
        const old = this.track;
        this.track = null;
        this.trackSetKey = null;
        old.fadeTo(0, fadeMs).then(() => old.dispose());
    }

    dispose(): void {
        this.stopTrack(0);
        this.preview.stop(0);
    }
}

function findTimingStart(timeline: ControlPointTimeline, time: number): number {
    // Start of the governing tempo section: walk back while beat length is
    // unchanged (inherited points keep the parent's beat length).
    const pts = timeline.points;
    let lo = 0, hi = pts.length - 1, idx = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].time <= time) {
            idx = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    const bl = pts[idx]?.beatLength;
    while (idx > 0 && pts[idx - 1].beatLength === bl) idx--;
    return pts[idx]?.time ?? 0;
}

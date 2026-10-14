import { Container, Rectangle, Sprite, Texture } from 'pixi.js';
import type { SkinTexture } from '../../skin/LegacySkin';
import type { SkinChain } from '../../skin/SkinChain';
import { SKIN_DEFAULTS } from '../../skin/SkinIni';

/** lazer's LegacyFont (the two HUD fonts). */
export type LegacyFontKind = 'score' | 'combo';

/** Characters a fixed-width font keeps at their own width (lazer's FixedWidthExcludeCharacters). */
const FIXED_WIDTH_EXCLUDE = new Set([',', '.', '%', 'x']);

/** Every glyph a HUD font is drawn with. */
const FONT_CHARS = '0123456789,.%x';

/**
 * A skin font's glyphs repacked into one texture. Skins ship each glyph
 * as its own image, so a rolling score swaps texture sources every frame,
 * which Pixi cannot patch into the existing batch: it rebuilds the whole
 * scene's draw list instead (most of a gameplay frame's CPU time). Frames
 * of one shared source swap in place.
 *
 * Cached by the glyph images they were made from: the HUD and its skin
 * chain are rebuilt every play, the skins themselves are not.
 */
const atlases = new Map<string, Map<string, SkinTexture | null>>();
const MAX_ATLASES = 4;

function atlasFor(glyphs: Map<string, SkinTexture | null>): Map<string, SkinTexture | null> {
    const key = [...glyphs.values()].map(g => g ? `${g.texture.source.uid}:${g.texture.frame.x},${g.texture.frame.y}` : '-').join('|');
    let packed = atlases.get(key);
    if (packed) {
        atlases.delete(key);
        atlases.set(key, packed);
        return packed;
    }
    packed = packGlyphs(glyphs);
    atlases.set(key, packed);
    while (atlases.size > MAX_ATLASES) {
        const [oldKey, old] = atlases.entries().next().value!;
        atlases.delete(oldKey);
        // Only atlases made here own their source; an unpacked map holds the skin's own textures.
        for (const g of old.values()) if (g && packedSources.has(g.texture.source)) g.texture.destroy(false);
        for (const g of old.values()) if (g && packedSources.delete(g.texture.source)) g.texture.source.destroy();
    }
    return packed;
}

/** Texture sources created by packGlyphs (safe to destroy on eviction). */
const packedSources = new Set<unknown>();

type Drawable = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas;

function packGlyphs(glyphs: Map<string, SkinTexture | null>): Map<string, SkinTexture | null> {
    const items: { ch: string; g: SkinTexture; res: Drawable; sx: number; sy: number; w: number; h: number }[] = [];
    for (const [ch, g] of glyphs) {
        if (!g) continue;
        const t = g.texture;
        const res = t.source.resource as Drawable | undefined;
        // Rotated or trimmed atlas frames would need more than a plain copy: keep the originals.
        if (!res || typeof (res as { width?: unknown }).width !== 'number' || t.rotate || t.trim) return glyphs;
        const r = t.source.pixelWidth / t.source.width || 1;
        items.push({ ch, g, res, sx: t.frame.x * r, sy: t.frame.y * r, w: Math.round(t.frame.width * r), h: Math.round(t.frame.height * r) });
    }
    if (items.length < 2 || typeof document === 'undefined') return glyphs;
    const PAD = 2;
    const width = items.reduce((a, it) => a + it.w + PAD, PAD);
    const height = Math.max(...items.map(it => it.h)) + PAD * 2;
    if (width > 8192 || height > 8192) return glyphs;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return glyphs;
    let x = PAD;
    const placed: { it: (typeof items)[number]; x: number }[] = [];
    for (const it of items) {
        ctx.drawImage(it.res, it.sx, it.sy, it.w, it.h, x, PAD, it.w, it.h);
        placed.push({ it, x });
        x += it.w + PAD;
    }
    const source = Texture.from(canvas).source;
    packedSources.add(source);
    const out = new Map(glyphs);
    for (const { it, x: px } of placed) {
        // Same size in texture units as the original, so layouts don't change.
        const texture = new Texture({ source, frame: new Rectangle(px, PAD, it.w, it.h) });
        const scale = it.g.scale * (it.g.texture.frame.width / it.w || 1);
        out.set(it.ch, { texture, scale });
    }
    return out;
}

/**
 * A skin's score or combo font (lazer's LegacyGlyphStore + GetFontPrefix /
 * GetFontOverlap): glyphs `${prefix}-0` … `${prefix}-x` from the skin
 * chain, and the overlap of the skin that actually provides the font, so
 * a skin that leaves ComboOverlap out gets osu!'s 0 rather than the
 * overlap of wosu!'s default skin underneath it.
 */
export class LegacyFont {
    readonly prefix: string;
    /** Display units each glyph overlaps the previous one; negative spreads them out. */
    readonly overlap: number;
    private readonly cache = new Map<string, SkinTexture | null>();

    constructor(private readonly chain: SkinChain, readonly kind: LegacyFontKind) {
        const prefixKey = kind === 'score' ? 'scorePrefix' : 'comboPrefix';
        const overlapKey = kind === 'score' ? 'scoreOverlap' : 'comboOverlap';
        this.prefix = chain.config(prefixKey);
        let overlap = SKIN_DEFAULTS[overlapKey];
        for (const l of chain.layers) {
            if (!l.skin || l.textures === false) continue;
            if (l.skin.texture(`${this.prefix}-0`)) {
                overlap = l.skin.config[overlapKey] ?? SKIN_DEFAULTS[overlapKey];
                break;
            }
        }
        this.overlap = overlap;
        const prefix = kind === 'score' ? 'scorePrefix' : 'comboPrefix';
        const glyphs = new Map<string, SkinTexture | null>();
        for (const ch of FONT_CHARS) glyphs.set(ch, chain.glyph(prefix, ch));
        for (const [ch, g] of atlasFor(glyphs)) this.cache.set(ch, g);
    }

    glyph(ch: string): SkinTexture | null {
        let g = this.cache.get(ch);
        if (g === undefined) {
            g = this.chain.glyph(this.kind === 'score' ? 'scorePrefix' : 'comboPrefix', ch);
            this.cache.set(ch, g);
        }
        return g;
    }

    /** Display width of a glyph (@2x images count half). */
    width(ch: string): number {
        const g = this.glyph(ch);
        return g ? g.texture.width * g.scale : 0;
    }
}

/**
 * lazer's LegacySpriteText: text drawn with a skin font's glyph images in
 * display units (@2x glyphs at half size), glyphs top-aligned, spaced by
 * -overlap. With `fixedWidth`, digits take the width of "5" and are
 * centred in it (o!f's fixed-width text), so rolling numbers don't jitter.
 * The origin is the text's top-left, or its top-right with `alignRight`.
 * Sprites are reused, so changing the text every frame allocates nothing.
 */
export class LegacySpriteText extends Container {
    private readonly sprites: Sprite[] = [];
    private current: string | null = null;
    /** Size of the current text in display units (before this container's scale). */
    textWidth = 0;
    textHeight = 0;
    private readonly fixed: number;

    constructor(readonly font: LegacyFont, private readonly opts: { fixedWidth?: boolean; alignRight?: boolean } = {}) {
        super();
        this.eventMode = 'none';
        this.fixed = opts.fixedWidth ? font.width('5') : 0;
    }

    /** Size `s` would have, without changing the text. */
    measure(s: string): { width: number; height: number } {
        const overlap = this.font.overlap;
        let x = 0;
        let h = 0;
        let n = 0;
        for (const ch of s) {
            const g = this.font.glyph(ch);
            if (!g) continue;
            if (n++ > 0) x -= overlap;
            x += this.fixed && !FIXED_WIDTH_EXCLUDE.has(ch) ? this.fixed : g.texture.width * g.scale;
            h = Math.max(h, g.texture.height * g.scale);
        }
        return { width: Math.max(0, x), height: h };
    }

    set text(s: string) {
        if (s === this.current) return;
        this.current = s;
        while (this.sprites.length < s.length) {
            const sp = new Sprite();
            this.sprites.push(sp);
            this.addChild(sp);
        }
        const overlap = this.font.overlap;
        let x = 0;
        let h = 0;
        let n = 0;
        for (let i = 0; i < this.sprites.length; i++) {
            const sp = this.sprites[i];
            const g = i < s.length ? this.font.glyph(s[i]) : null;
            if (!g) {
                sp.visible = false;
                continue;
            }
            if (n++ > 0) x -= overlap;
            const w = g.texture.width * g.scale;
            const advance = this.fixed && !FIXED_WIDTH_EXCLUDE.has(s[i]) ? this.fixed : w;
            sp.visible = true;
            sp.texture = g.texture;
            sp.scale.set(g.scale);
            sp.x = x + (advance - w) / 2;
            sp.y = 0;
            x += advance;
            h = Math.max(h, g.texture.height * g.scale);
        }
        this.textWidth = Math.max(0, x);
        this.textHeight = h;
        if (this.opts.alignRight) {
            for (const sp of this.sprites) sp.x -= this.textWidth;
        }
    }

    get text(): string {
        return this.current ?? '';
    }
}

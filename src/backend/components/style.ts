/**
 * Shared styling. The stack was originally the bare OS default (San
 * Francisco on Mac, Segoe on Windows) — clean native look, no font file to
 * ship. That only works while rendering happens on one machine: none of
 * those faces exist on a Linux render host, so the stack fell through to
 * whatever `sans-serif` maps to there (DejaVu Sans on a stock Ubuntu),
 * whose wider metrics rewrap captions and titles that were laid out
 * against SF. Inter is pinned in front so a render is byte-identical
 * wherever it runs; the OS faces stay behind it as the fallback chain for
 * anywhere the file fails to load. Loaded by remotion/fonts.ts.
 */
export const INTER_FONT = "Inter";
export const SYSTEM_FONT =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, Helvetica, Arial, sans-serif';

export const TEXT_SHADOW = "0 2px 12px rgba(0,0,0,0.45)";

/** Display faces for StickerTitle (loaded via remotion/fonts.ts). Family
 * names end in SYSTEM_FONT so a blocked/missing font file still renders. */
export const ARCHIVO_BLACK_FONT = "Archivo Black";
export const MONTSERRAT_ITALIC_FONT = "Montserrat Italic";
export const ARCHIVO_BLACK_STACK = `"${ARCHIVO_BLACK_FONT}", ${SYSTEM_FONT}`;
export const MONTSERRAT_ITALIC_STACK = `"${MONTSERRAT_ITALIC_FONT}", ${SYSTEM_FONT}`;

export const STICKER_ACCENT = "#EC7A5E";

/** High-contrast Didone serif for TextOverlay's "kumarTitle" variant —
 *  the "KUMAR'S DEBUT" / big-word look: a magazine-cover serif, not the
 *  system sans every other variant uses. Fallback chain still ends in a
 *  system SERIF (not SYSTEM_FONT) so a blocked font file degrades to a
 *  native serif rather than silently becoming sans-serif. */
export const PLAYFAIR_DISPLAY_FONT = "Playfair Display Black";
export const PLAYFAIR_DISPLAY_STACK = `"${PLAYFAIR_DISPLAY_FONT}", Georgia, "Times New Roman", serif`;

/** Geometric grotesque (circular bowls, flat-cut terminals) used by the
 *  cs-resources reference reel's hook/resolve/card/CTA text — measured by
 *  eye against the source footage, not an exact face match (no on-screen
 *  attribution to confirm the original), so Poppins stands in as the
 *  closest freely-licensed substitute. Loaded per-event via TextOverlay's
 *  "fontFamily" param override, not a global VARIANTS default, so formats
 *  that don't ask for it keep rendering SYSTEM_FONT exactly as before. */
export const POPPINS_FONT = "Poppins";
export const POPPINS_STACK = `"${POPPINS_FONT}", ${SYSTEM_FONT}`;

/** The red used by the reference reel's titles and captions — measured
 *  directly from the reference footage (mean of every nearly-pure-red
 *  pixel in a title-card frame: rgb(248,2,3)), not the prior hand-picked
 *  #E31E24 (a darker, more muted red the reference doesn't actually use). */
export const KUMAR_RED = "#F80203";

/** Rough width-fit for a Didone-serif uppercase title (Captions.tsx's
 *  bigTitle/karaokeTitle cards, TextOverlay's kumarSplitTitle) — no canvas
 *  text measurement available inline in a Remotion render, so this
 *  approximates a bold serif uppercase glyph's average width as a
 *  fraction of its own font size. Good enough to keep a short word and a
 *  long word both spanning roughly the same fraction of frame width,
 *  which a single fixed fontSize can't do. `frameHeight`, when given,
 *  adds a second cap so a SHORT word (few characters, width alone would
 *  size it huge) doesn't balloon past a sane fraction of the frame's own
 *  height — width-fit and height-cap combined, not either alone. */
export const fitDidoneFontSize = (text: string, frameWidth: number, frameHeight?: number, maxPx = 260, minPx = 56): number => {
  const CHAR_WIDTH_FACTOR = 0.62;
  const targetWidthPx = frameWidth * 0.9;
  const raw = targetWidthPx / (Math.max(1, text.length) * CHAR_WIDTH_FACTOR);
  const heightCap = frameHeight !== undefined ? frameHeight * 0.16 : maxPx;
  return Math.min(maxPx, heightCap, Math.max(minPx, raw));
};

// ---------------------------------------------------------------------------
// TextOverlay / Captions shared typography — framework-free (no remotion
// import) so the editor's Inspector/OverlayCanvas can read the same
// defaults a render uses, instead of hand-copied numbers that silently
// drift the first time either side changes.
// ---------------------------------------------------------------------------

export type TextVariant = "hook" | "resolve" | "title" | "description" | "cta" | "kumarTitle";

/** TextOverlay's per-variant house styles — the values an event falls back
 *  to when it doesn't (or, once user-edited, no longer) set its own
 *  fontSize/color/etc. See TextOverlay.tsx for how these compose with a
 *  per-event override. */
export const TEXT_VARIANTS: Record<
  TextVariant,
  { fontSize: number; fontWeight: number; color: string; fontFamily?: string; uppercase?: boolean }
> = {
  hook: { fontSize: 86, fontWeight: 800, color: "white" },
  resolve: { fontSize: 120, fontWeight: 900, color: "white" },
  title: { fontSize: 64, fontWeight: 800, color: "white" },
  description: { fontSize: 40, fontWeight: 500, color: "rgba(255,255,255,0.92)" },
  cta: { fontSize: 60, fontWeight: 800, color: "white" },
  kumarTitle: { fontSize: 96, fontWeight: 900, color: KUMAR_RED, fontFamily: PLAYFAIR_DISPLAY_STACK, uppercase: true },
};

/** Shorthand keys a format (or the editor's Font picker) can pass as
 *  "fontFamily" instead of hand-writing a full CSS stack. Anything not in
 *  this map is used as a literal CSS font-family value verbatim (escape
 *  hatch for a one-off stack no shorthand covers). */
export const FONT_FAMILY_SHORTHANDS: Record<string, string> = {
  system: SYSTEM_FONT,
  poppins: POPPINS_STACK,
  playfair: PLAYFAIR_DISPLAY_STACK,
  archivo: ARCHIVO_BLACK_STACK,
  montserrat: MONTSERRAT_ITALIC_STACK,
};

/** The Font picker's own option list — shorthand key + display label,
 *  ordered the way they should appear in the dropdown. */
export const FONT_OPTIONS: { value: string; label: string }[] = [
  { value: "system", label: "System" },
  { value: "poppins", label: "Poppins" },
  { value: "playfair", label: "Playfair Display" },
  { value: "archivo", label: "Archivo Black" },
  { value: "montserrat", label: "Montserrat Italic" },
];

/** A lowerThird caption group's default per-word font size before any
 *  user override — mirrors Captions.tsx's own LowerThirdLine formula
 *  exactly (isKumar ? 64 : isOutro ? 46 : 52), duplicated here (not
 *  measured from the DOM) since it's three fixed constants keyed only by
 *  theme, not layout that could plausibly drift underneath a hand copy. */
export const defaultLowerThirdFontSize = (theme: string | undefined): number =>
  theme === "kumar" ? 64 : theme === "outroYellow" ? 46 : 52;

/** Mirrors LowerThirdLine's own non-active-word color (isKumar ? KUMAR_RED
 *  : isOutro ? yellow : white) — the base color the Inspector's swatch
 *  should show before any per-group override. Doesn't attempt to mirror
 *  the active-word keyword-highlight pop (yellow), which is a per-frame
 *  animation state, not a static "current color" a picker can represent. */
export const defaultLowerThirdColor = (theme: string | undefined): string =>
  theme === "kumar" ? KUMAR_RED : theme === "outroYellow" ? "#FFD400" : "white";

export const defaultLowerThirdFontWeight = (theme: string | undefined): number => (theme === "outroYellow" ? 700 : 800);

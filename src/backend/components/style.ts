/**
 * Shared styling. Using the system font stack as requested — this
 * renders with the OS default (San Francisco on Mac, Segoe on Windows),
 * which gives that clean native look without shipping a font file.
 */
export const SYSTEM_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, Helvetica, Arial, sans-serif';

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

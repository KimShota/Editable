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

/** The red used by the reference reel's titles and captions. */
export const KUMAR_RED = "#E31E24";

/** Rough width-fit for a Didone-serif uppercase title (Captions.tsx's
 *  bigTitle cards, TextOverlay's kumarSplitTitle) — no canvas text
 *  measurement available inline in a Remotion render, so this
 *  approximates a bold serif uppercase glyph's average width as a
 *  fraction of its own font size. Good enough to keep a short word and a
 *  long word both spanning roughly the same fraction of frame width,
 *  which a single fixed fontSize can't do. */
export const fitDidoneFontSize = (text: string, frameWidth: number, maxPx = 150, minPx = 56): number => {
  const CHAR_WIDTH_FACTOR = 0.62;
  const targetWidthPx = frameWidth * 0.86;
  const raw = targetWidthPx / (Math.max(1, text.length) * CHAR_WIDTH_FACTOR);
  return Math.min(maxPx, Math.max(minPx, raw));
};

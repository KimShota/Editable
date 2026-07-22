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

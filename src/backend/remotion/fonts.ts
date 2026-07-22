import { continueRender, delayRender, staticFile } from "remotion";
import { ARCHIVO_BLACK_FONT, MONTSERRAT_ITALIC_FONT } from "../components/style";

/**
 * Injects the display faces used by StickerTitle and loads them before the
 * frame renders, so headless exports never rasterize a fallback face.
 * Safe under Next SSR (no document at module scope); idempotent so every
 * component instance can call it.
 */
let injected = false;

export const ensureStickerFonts = (): void => {
  if (typeof document === "undefined" || injected) return;
  injected = true;

  const style = document.createElement("style");
  style.textContent = `
    @font-face {
      font-family: "${ARCHIVO_BLACK_FONT}";
      src: url("${staticFile("fonts/archivo-black.woff2")}") format("woff2");
      font-weight: 400;
      font-style: normal;
      font-display: block;
    }
    @font-face {
      font-family: "${MONTSERRAT_ITALIC_FONT}";
      src: url("${staticFile("fonts/montserrat-800-italic.woff2")}") format("woff2");
      font-weight: 800;
      font-style: italic;
      font-display: block;
    }
  `;
  document.head.appendChild(style);

  const handle = delayRender("Loading StickerTitle fonts");
  Promise.all([
    document.fonts.load(`400 100px "${ARCHIVO_BLACK_FONT}"`),
    document.fonts.load(`800 italic 100px "${MONTSERRAT_ITALIC_FONT}"`),
  ])
    .catch(() => {
      // Missing/blocked font files degrade to the SYSTEM_FONT fallback in
      // the family stacks below; the render should still proceed.
    })
    .then(() => continueRender(handle));
};

import { continueRender, delayRender, staticFile } from "remotion";
import { ARCHIVO_BLACK_FONT, INTER_FONT, MONTSERRAT_ITALIC_FONT, PLAYFAIR_DISPLAY_FONT, POPPINS_FONT } from "../components/style";

/**
 * Injects every face the compositions use — Inter (SYSTEM_FONT's pinned
 * body face) plus the display faces used by non-system-font components
 * (StickerTitle, SkillCard, TextOverlay's "kumarTitle" variant, and any
 * TextOverlay event that opts into "fontFamily": "poppins") — and loads
 * them before the frame renders, so headless exports never rasterize a
 * fallback face. Safe under Next SSR (no document at module scope);
 * idempotent so every component instance can call it.
 *
 * EdlVideo calls this at the composition root rather than leaving it to
 * the components: HookBlock/ResourceBlock/CtaBlock/ImageOverlay all style
 * with SYSTEM_FONT but never call in here, so relying on per-component
 * calls would make Inter's presence depend on which overlays a given frame
 * happens to contain — the same text rendering in a different face from
 * one segment to the next.
 */
let injected = false;

export const ensureDisplayFonts = (): void => {
  if (typeof document === "undefined" || injected) return;
  injected = true;

  const style = document.createElement("style");
  style.textContent = `
    @font-face {
      font-family: "${INTER_FONT}";
      src: url("${staticFile("fonts/inter-variable.woff2")}") format("woff2");
      /* One variable file spanning the whole axis, so every weight the
         compositions use (400/500/800/900) comes from a single request. */
      font-weight: 100 900;
      font-style: normal;
      font-display: block;
    }
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
    @font-face {
      font-family: "${PLAYFAIR_DISPLAY_FONT}";
      src: url("${staticFile("fonts/playfair-display-black.woff2")}") format("woff2");
      font-weight: 900;
      font-style: normal;
      font-display: block;
    }
    @font-face {
      font-family: "${POPPINS_FONT}";
      src: url("${staticFile("fonts/poppins-500.woff2")}") format("woff2");
      font-weight: 500;
      font-style: normal;
      font-display: block;
    }
    @font-face {
      font-family: "${POPPINS_FONT}";
      src: url("${staticFile("fonts/poppins-700.woff2")}") format("woff2");
      font-weight: 700;
      font-style: normal;
      font-display: block;
    }
    @font-face {
      font-family: "${POPPINS_FONT}";
      src: url("${staticFile("fonts/poppins-800.woff2")}") format("woff2");
      font-weight: 800;
      font-style: normal;
      font-display: block;
    }
    @font-face {
      font-family: "${POPPINS_FONT}";
      src: url("${staticFile("fonts/poppins-900.woff2")}") format("woff2");
      font-weight: 900;
      font-style: normal;
      font-display: block;
    }
  `;
  document.head.appendChild(style);

  const handle = delayRender("Loading composition fonts");
  Promise.all([
    ...[400, 500, 800, 900].map((w) => document.fonts.load(`${w} 100px "${INTER_FONT}"`)),
    document.fonts.load(`400 100px "${ARCHIVO_BLACK_FONT}"`),
    document.fonts.load(`800 italic 100px "${MONTSERRAT_ITALIC_FONT}"`),
    document.fonts.load(`900 100px "${PLAYFAIR_DISPLAY_FONT}"`),
    document.fonts.load(`500 100px "${POPPINS_FONT}"`),
    document.fonts.load(`700 100px "${POPPINS_FONT}"`),
    document.fonts.load(`800 100px "${POPPINS_FONT}"`),
    document.fonts.load(`900 100px "${POPPINS_FONT}"`),
  ])
    .catch(() => {
      // Missing/blocked font files degrade to the SYSTEM_FONT fallback in
      // the family stacks below; the render should still proceed.
    })
    .then(() => continueRender(handle));
};

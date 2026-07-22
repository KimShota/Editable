import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { ARCHIVO_BLACK_STACK } from "../../components/style";
import { ensureStickerFonts } from "../fonts";
import { PaperPatch } from "./PaperPatch";

/**
 * A code/skill's name in a paper patch, with its preview image below it —
 * the per-code-block beat that replaces the old scrim-and-text TitleCard.
 * `text` comes from the block's captured name (textAnchor), title-cased for
 * display since the raw transcript capture is normally lowercase ("goat
 * mode" -> "Goat Mode"); `src` is the matching preview image (imageSlot).
 */

const titleCase = (s: string): string =>
  s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

export const SkillCard: React.FC<{
  text?: string;
  src?: string;
  fontSize?: number;
}> = ({ text = "", src, fontSize = 72 }) => {
  ensureStickerFonts();

  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ frame, fps, config: { damping: 13, stiffness: 220 } });
  const scale = interpolate(progress, [0, 1], [1.3, 1]);

  return (
    <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "center", paddingTop: "8%" }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 22,
          opacity: progress,
          transform: `scale(${scale})`,
        }}
      >
        {text && (
          <PaperPatch rotateDeg={-3}>
            <span
              style={{
                fontFamily: ARCHIVO_BLACK_STACK,
                fontWeight: 400,
                fontSize,
                lineHeight: 1,
                color: "#161412",
              }}
            >
              {titleCase(text)}
            </span>
          </PaperPatch>
        )}
        {src && (
          <Img
            src={staticFile(src)}
            style={{
              width: "78%",
              maxHeight: "55%",
              objectFit: "cover",
              borderRadius: 20,
              boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
            }}
          />
        )}
      </div>
    </AbsoluteFill>
  );
};

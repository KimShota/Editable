import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  ARCHIVO_BLACK_STACK,
  MONTSERRAT_ITALIC_STACK,
  STICKER_ACCENT,
} from "../../components/style";
import { ensureStickerFonts } from "../fonts";
import { PaperPatch } from "./PaperPatch";

/**
 * The "5 SECRET / Claude codes" hook title: a rotated sticky-note patch
 * holding the number, a heavy uppercase headline, and an italic coral
 * subhead — no background scrim, sits over the live footage.
 *
 * `text` is what textAnchor/textTemplate resolution always produces
 * (assemble.ts always names the resolved param "text"), so when the
 * explicit parts aren't given, they're derived from it: line 1's leading
 * number token becomes the patch, the rest of line 1 is the headline, and
 * line 2 is the subhead. This keeps existing format configs — e.g.
 * `textTemplate: "5 SECRET\n{captured}"` — working unchanged.
 */

const splitText = (
  text: string,
): { patchText: string; headline: string; subhead: string } => {
  const [firstLine = "", secondLine = ""] = text.split("\n");
  const match = firstLine.match(/^(\d+)\s*(.*)$/);
  return {
    patchText: match ? match[1] : "",
    headline: match ? match[2] : firstLine,
    subhead: secondLine,
  };
};

export const StickerTitle: React.FC<{
  text?: string;
  patchText?: string;
  headline?: string;
  subhead?: string;
  accentColor?: string;
  fontSize?: number;
  position?: "top" | "center";
}> = ({
  text = "",
  patchText,
  headline,
  subhead,
  accentColor = STICKER_ACCENT,
  fontSize = 80,
  position = "top",
}) => {
  ensureStickerFonts();

  const derived = splitText(text);
  const resolvedPatch = patchText ?? derived.patchText;
  const resolvedHeadline = headline ?? derived.headline;
  const resolvedSubhead = subhead ?? derived.subhead;

  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ frame, fps, config: { damping: 13, stiffness: 220 } });
  const scale = interpolate(progress, [0, 1], [1.3, 1]);

  const hardShadow =
    "3px 3px 0 rgba(0,0,0,0.55), 0 10px 18px rgba(0,0,0,0.35)";

  return (
    <AbsoluteFill
      style={{
        justifyContent: position === "center" ? "center" : "flex-start",
        alignItems: "center",
        paddingTop: position === "center" ? 0 : "10%",
        padding: position === "center" ? 60 : undefined,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          opacity: progress,
          transform: `scale(${scale})`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 18,
            flexWrap: "wrap",
            padding: "0 60px",
          }}
        >
          {resolvedPatch && (
            <PaperPatch rotateDeg={-4} padding={`${fontSize * 0.08}px ${fontSize * 0.28}px`}>
              <span
                style={{
                  fontFamily: ARCHIVO_BLACK_STACK,
                  fontWeight: 400,
                  fontSize: fontSize * 1.15,
                  lineHeight: 1,
                  color: "#161412",
                }}
              >
                {resolvedPatch}
              </span>
            </PaperPatch>
          )}
          {resolvedHeadline && (
            <span
              style={{
                fontFamily: ARCHIVO_BLACK_STACK,
                fontWeight: 400,
                fontSize,
                lineHeight: 1,
                color: "white",
                textAlign: "center",
                textTransform: "uppercase",
                letterSpacing: 1,
                textShadow: hardShadow,
              }}
            >
              {resolvedHeadline}
            </span>
          )}
        </div>
        {resolvedSubhead && (
          <span
            style={{
              fontFamily: MONTSERRAT_ITALIC_STACK,
              fontWeight: 800,
              fontStyle: "italic",
              fontSize: fontSize * 1.05,
              lineHeight: 1.15,
              color: accentColor,
              textAlign: "center",
              textShadow: hardShadow,
              marginTop: 8,
            }}
          >
            {resolvedSubhead}
          </span>
        )}
      </div>
    </AbsoluteFill>
  );
};

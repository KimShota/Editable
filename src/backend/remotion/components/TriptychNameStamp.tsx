import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { KUMAR_RED, PLAYFAIR_DISPLAY_STACK, TEXT_SHADOW, fitDidoneFontSize } from "../../components/style";
import { ensureDisplayFonts } from "../fonts";

/**
 * The triptych's own name stamp (plan v6 §3): the reference reel's title
 * card, composited onto ONE frame before Kumar's team split it into three
 * stacked panels, ends up appearing once per panel when that split video
 * plays — not one title spanning the whole canvas. Reproduced here as
 * ONE overlay event (not three authored separately) so the panel geometry
 * lives in exactly one place.
 *
 * PANEL_HEIGHT_FRACS mirrors generation/modelShots.ts's own
 * TRIPTYCH_PANEL_HEIGHT_FRACS exactly (kept as a literal, not an import:
 * modelShots.ts pulls in node:fs/node:child_process, which can't bundle
 * into a Remotion component) — if that constant ever changes, this must
 * change with it or the stamp drifts out of alignment with the panel
 * seams underneath it.
 */
const PANEL_HEIGHT_FRACS = [0.35, 0.32, 0.33];

export const TriptychNameStamp: React.FC<{ text?: string; fontSize?: number }> = ({ text = "", fontSize }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  ensureDisplayFonts();

  // A flash, not a sustained title: fade in quickly and let the event's
  // own short authored duration (schemas.ts's FormatEventSchema
  // durationSec, ~0.25s near the triptych's end — see the format config)
  // end it on a soft-enough cut that a hard Sequence unmount doesn't read
  // as a glitch at this brief a duration.
  const fadeInFrames = Math.max(1, Math.round(fps * 0.08));
  const opacity = interpolate(frame, [0, fadeInFrames], [0, 1], { extrapolateRight: "clamp" });

  let topFrac = 0;
  return (
    <AbsoluteFill style={{ opacity }}>
      {PANEL_HEIGHT_FRACS.map((hFrac, i) => {
        const panelHeightPx = hFrac * height;
        const box: React.CSSProperties = {
          position: "absolute",
          top: `${topFrac * 100}%`,
          left: 0,
          width: "100%",
          height: `${hFrac * 100}%`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        };
        topFrac += hFrac;
        return (
          <div key={i} style={box}>
            <div
              style={{
                fontFamily: PLAYFAIR_DISPLAY_STACK,
                fontWeight: 900,
                fontSize: fontSize ?? fitDidoneFontSize(text, width, panelHeightPx),
                color: KUMAR_RED,
                textAlign: "center",
                textShadow: TEXT_SHADOW,
                textTransform: "uppercase",
                whiteSpace: "nowrap",
              }}
            >
              {text}
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

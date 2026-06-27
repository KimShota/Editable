import React from "react";
import {
  AbsoluteFill,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { SYSTEM_FONT, TEXT_SHADOW } from "./style";

type Props = {
  clip: string;
  textHook: string;
  resolveText: string;
  /** Frame, local to this block, where resolveText punches in (sync to the beat) */
  resolveAtFrame: number;
};

export const HookBlock: React.FC<Props> = ({
  clip,
  textHook,
  resolveText,
  resolveAtFrame,
}) => {
  const frame = useCurrentFrame();

  // Painpoint text is visible until the resolve, then swaps to resolveText.
  const showingResolve = frame >= resolveAtFrame;

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <OffthreadVideo
        src={staticFile(clip)}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          padding: 60,
        }}
      >
        {!showingResolve ? (
          <div
            style={{
              fontFamily: SYSTEM_FONT,
              fontWeight: 800,
              fontSize: 86,
              lineHeight: 1.1,
              color: "white",
              textAlign: "center",
              textShadow: TEXT_SHADOW,
              whiteSpace: "pre-line",
            }}
          >
            {textHook}
          </div>
        ) : (
          <div
            style={{
              fontFamily: SYSTEM_FONT,
              fontWeight: 900,
              fontSize: 120,
              color: "white",
              textAlign: "center",
              textShadow: TEXT_SHADOW,
            }}
          >
            {resolveText}
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

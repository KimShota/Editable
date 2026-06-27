import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";
import { SYSTEM_FONT, TEXT_SHADOW } from "./style";

type Props = {
  clip: string;
  text: string;
};

export const CtaBlock: React.FC<Props> = ({ clip, text }) => {
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
          padding: "0 60px",
        }}
      >
        <div
          style={{
            fontFamily: SYSTEM_FONT,
            fontWeight: 800,
            fontSize: 60,
            color: "white",
            textAlign: "center",
            textShadow: TEXT_SHADOW,
            lineHeight: 1.2,
          }}
        >
          {text}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

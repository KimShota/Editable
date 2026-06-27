import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";
import { SYSTEM_FONT, TEXT_SHADOW } from "./style";

type Props = {
  clip: string;
  title: string;
  description: string;
};

export const ResourceBlock: React.FC<Props> = ({
  clip,
  title,
  description,
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <OffthreadVideo
        src={staticFile(clip)}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
      {/* Title (near center, above) + description (slightly below it),
          overlaid directly on the screen-recording — no background box. */}
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
            fontSize: 64,
            color: "white",
            textAlign: "center",
            textShadow: TEXT_SHADOW,
            marginBottom: 16,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontFamily: SYSTEM_FONT,
            fontWeight: 500,
            fontSize: 40,
            color: "rgba(255,255,255,0.92)",
            textAlign: "center",
            textShadow: TEXT_SHADOW,
            lineHeight: 1.25,
          }}
        >
          {description}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

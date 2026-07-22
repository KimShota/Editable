import React from "react";

/**
 * The rotated sticky-note patch background shared by StickerTitle (the
 * numeral) and SkillCard (a skill's name) — a torn-paper card with a soft
 * shadow, sitting on top of the footage.
 */
export const PaperPatch: React.FC<{
  children: React.ReactNode;
  rotateDeg?: number;
  padding?: string;
}> = ({ children, rotateDeg = -4, padding = "10px 28px" }) => (
  <div
    style={{
      display: "inline-block",
      transform: `rotate(${rotateDeg}deg)`,
      background: "linear-gradient(155deg, #ffffff 0%, #f3f1ec 55%, #eae7df 100%)",
      borderRadius: 10,
      boxShadow: "0 10px 20px rgba(0,0,0,0.4), 0 2px 4px rgba(0,0,0,0.25)",
      padding,
    }}
  >
    {children}
  </div>
);

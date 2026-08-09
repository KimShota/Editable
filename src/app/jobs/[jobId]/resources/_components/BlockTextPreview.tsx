"use client";

import type { CSSProperties } from "react";
import type { Block, Format } from "@backend/pipeline/types";
import { FONT_FAMILY_SHORTHANDS, TEXT_VARIANTS, type TextVariant } from "@backend/components/style";

const PREVIEW_WIDTH = 200;

/** The subset of TextOverlay's own params this preview understands — see
 *  src/backend/remotion/components/TextOverlay.tsx, which this mirrors at
 *  preview scale so a typed value shows up exactly where/how it will
 *  render, without pulling in Remotion itself. */
type TextOverlayParams = {
  textSlot?: string;
  variant?: string;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  fontWeight?: number;
  italic?: boolean;
  underline?: boolean;
  textCase?: "upper" | "lower" | "none";
  background?: string;
  backgroundRadius?: number;
  paddingX?: number;
  paddingY?: number;
};

/**
 * A miniature 9:16 frame showing exactly where this block's text slots
 * land in the finished video and how they're styled — updates live as the
 * user types. Renders every TextOverlay event on the block at once (not
 * scrubbed by time), since the goal is teaching placement, not replaying
 * the timeline; sequential events with no explicit layout can visually
 * overlap here even though they never appear on screen together in the
 * real render. "kumarSplitTitle" (a hand-built split-line layout, not a
 * TEXT_VARIANTS entry) falls back to the same centered "hook" look
 * TextOverlay itself falls back to for any unrecognized variant.
 */
export function BlockTextPreview({
  format,
  block,
  values,
}: {
  format: Format;
  block: Block;
  /** Current draft text per slot name (controlled value from the parent
   *  card). An unset/empty slot shows its `example` as faint ghost text
   *  instead of rendering nothing. */
  values: Record<string, string>;
}) {
  const scale = PREVIEW_WIDTH / format.width;
  const previewHeight = format.height * scale;

  const textEvents = block.events.filter(
    (e) => e.kind === "overlay" && e.component.component === "TextOverlay",
  );
  if (textEvents.length === 0) return null;

  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-xl border border-white/10 bg-black"
      style={{ width: PREVIEW_WIDTH, height: previewHeight }}
    >
      {textEvents.map((event) => {
        const params = (event.component.params ?? {}) as TextOverlayParams;
        const slotName = params.textSlot;
        if (!slotName) return null;
        const slot = block.slots.find((s) => s.name === slotName);
        const draft = values[slotName] ?? "";
        const isGhost = !draft.trim();
        const text = isGhost ? (slot?.example ?? "") : draft;
        if (!text) return null;

        const variantKey = (params.variant ?? "hook") as TextVariant;
        const style = TEXT_VARIANTS[variantKey in TEXT_VARIANTS ? variantKey : "hook"];
        const resolvedFontFamily = params.fontFamily
          ? (FONT_FAMILY_SHORTHANDS[params.fontFamily] ?? params.fontFamily)
          : style.fontFamily;
        const textTransform =
          params.textCase === "upper"
            ? "uppercase"
            : params.textCase === "lower"
              ? "lowercase"
              : params.textCase === "none"
                ? "none"
                : style.uppercase
                  ? "uppercase"
                  : undefined;

        const layout = event.layout;
        const positionStyle: CSSProperties = layout
          ? {
              position: "absolute",
              left: layout.x * PREVIEW_WIDTH,
              top: layout.y * previewHeight,
              width: layout.width * PREVIEW_WIDTH,
              height: layout.height * previewHeight,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }
          : {
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 8,
            };

        return (
          <div key={event.id} style={positionStyle}>
            <div
              style={{
                fontFamily: resolvedFontFamily,
                fontWeight: params.fontWeight ?? style.fontWeight,
                fontStyle: params.italic ? "italic" : undefined,
                textDecoration: params.underline ? "underline" : undefined,
                fontSize: (params.fontSize ?? style.fontSize) * scale,
                lineHeight: 1.15,
                color: params.color ?? style.color,
                textAlign: "center",
                textShadow: params.background ? "none" : "0 1px 4px rgba(0,0,0,0.45)",
                textTransform,
                whiteSpace: "pre-line",
                opacity: isGhost ? 0.4 : 1,
                maxWidth: "100%",
                ...(params.background
                  ? {
                      display: "inline-block",
                      background: params.background,
                      borderRadius: (params.backgroundRadius ?? 28) * scale,
                      padding: `${(params.paddingY ?? 22) * scale}px ${(params.paddingX ?? 40) * scale}px`,
                    }
                  : {}),
              }}
            >
              {text}
            </div>
          </div>
        );
      })}
    </div>
  );
}

import React from "react";
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { MotionChannel, MotionEasing, MotionPhase, MotionSpec } from "../../pipeline/types";

/**
 * The generic player for MotionSpec (see schemas.ts's own doc comment on
 * the format's motion-as-data section for the design rationale). Wraps ANY
 * overlay component's rendered output in a transform + opacity derived
 * from the event's own `motion` — enter animates over the first
 * `enter.durationSec`, exit over the last `exit.durationSec`, and the
 * (usual, much longer) stretch in between just holds at rest. One
 * implementation here means every registered overlay component gets
 * enter/exit animation for free, without any animation code of its own.
 */

type MotionEasingFn = (t: number) => number;

const easingFn = (e: MotionEasing): MotionEasingFn => {
  switch (e.kind) {
    case "linear":
      return Easing.linear;
    case "cubicBezier":
      return Easing.bezier(e.x1, e.y1, e.x2, e.y2);
    case "spring":
      return Easing.spring({ damping: e.damping, mass: e.mass, stiffness: e.stiffness });
  }
};

/** Piecewise-linear-between-keyframes, eased per segment — the standard
 *  keyframe-animation evaluation model (After Effects, CSS, etc): walk to
 *  whichever [prev, next] keyframe pair straddles `progress01`, ease the
 *  LOCAL (0..1 within that segment) position with the segment's own
 *  (next keyframe's) easing, then linearly blend prev.value -> next.value
 *  by the eased position. Undefined channel (this phase doesn't animate
 *  this property at all) or a progress outside [0,1] both just return
 *  `restValue` — the element's normal, motion-free appearance. */
const evalChannel = (channel: MotionChannel | undefined, progress01: number, restValue: number): number => {
  if (!channel || channel.length === 0) return restValue;
  const p = Math.max(0, Math.min(1, progress01));
  for (let i = 1; i < channel.length; i++) {
    const prev = channel[i - 1];
    const next = channel[i];
    if (p <= next.at || i === channel.length - 1) {
      const span = next.at - prev.at;
      const localT = span > 0 ? Math.max(0, Math.min(1, (p - prev.at) / span)) : 1;
      const eased = easingFn(next.easing)(localT);
      return prev.value + (next.value - prev.value) * eased;
    }
  }
  return channel[channel.length - 1].value;
};

const REST = { x: 0, y: 0, scale: 1, rotate: 0, opacity: 1 };

/** Which phase (if any) is active at this LOCAL frame, and how far into it
 *  (0..1) — enter takes priority if enter/exit somehow overlap (a
 *  pathological very-short element), which just compresses the exit
 *  rather than producing an overlapping/undefined blend. */
const activePhase = (
  spec: MotionSpec,
  frame: number,
  totalFrames: number,
  fps: number,
): { phase: MotionPhase; progress01: number } | undefined => {
  if (spec.enter) {
    const enterFrames = Math.round(spec.enter.durationSec * fps);
    if (frame < enterFrames) {
      return { phase: spec.enter, progress01: enterFrames > 0 ? frame / enterFrames : 1 };
    }
  }
  if (spec.exit) {
    const exitFrames = Math.round(spec.exit.durationSec * fps);
    const exitStartFrame = totalFrames - exitFrames;
    if (frame >= exitStartFrame) {
      return { phase: spec.exit, progress01: exitFrames > 0 ? (frame - exitStartFrame) / exitFrames : 1 };
    }
  }
  return undefined;
};

/** Per-component fallback MotionSpec, used whenever a format authors no
 *  `motion` of its own on an event — this is what keeps every EXISTING
 *  format rendering exactly as it always has (byte-identical enter timing)
 *  without needing to author anything new. Reproduces ImageOverlay's own
 *  former hardcoded animation (a 5-frame opacity/scale pop-in — every
 *  format using it today runs at 30fps, where 5 frames === 5/30 sec
 *  exactly) now that the component itself carries no animation code of
 *  its own; a component with no entry here (every other registered
 *  component) simply renders with no motion at all, same as before this
 *  system existed. */
export const DEFAULT_MOTION_BY_COMPONENT: Partial<Record<string, MotionSpec>> = {
  ImageOverlay: {
    enter: {
      durationSec: 5 / 30,
      opacity: [
        { at: 0, value: 0, easing: { kind: "linear" } },
        { at: 1, value: 1, easing: { kind: "linear" } },
      ],
      scale: [
        { at: 0, value: 0.85, easing: { kind: "linear" } },
        { at: 1, value: 1, easing: { kind: "linear" } },
      ],
    },
  },
};

export const MotionWrapper: React.FC<{
  motion?: MotionSpec;
  /** The wrapping Sequence's own total length — needed to know when the
   *  exit phase's own window begins (it's measured back from the END of
   *  the element's lifetime, not a fixed start frame). */
  totalDurationInFrames: number;
  children: React.ReactNode;
}> = ({ motion, totalDurationInFrames, children }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  if (!motion || (!motion.enter && !motion.exit)) return <>{children}</>;

  const active = activePhase(motion, frame, totalDurationInFrames, fps);
  const x = evalChannel(active?.phase.x, active?.progress01 ?? 0, REST.x);
  const y = evalChannel(active?.phase.y, active?.progress01 ?? 0, REST.y);
  const scale = evalChannel(active?.phase.scale, active?.progress01 ?? 0, REST.scale);
  const rotate = evalChannel(active?.phase.rotate, active?.progress01 ?? 0, REST.rotate);
  const opacity = evalChannel(active?.phase.opacity, active?.progress01 ?? 0, REST.opacity);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        opacity: interpolate(opacity, [0, 1], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
        // x/y are fractions of the COMPOSITION's own width/height (see
        // schemas.ts's MotionPhaseSchema doc comment), not of whatever box
        // this wrapper happens to sit inside — a CSS percentage translate
        // would be relative to THIS element's own (often much smaller)
        // box, so pixel values from useVideoConfig() are used instead to
        // keep "off-screen" actually meaning off the full frame regardless
        // of the wrapped overlay's own box size.
        transform: `translate(${x * width}px, ${y * height}px) scale(${scale}) rotate(${rotate}deg)`,
      }}
    >
      {children}
    </div>
  );
};

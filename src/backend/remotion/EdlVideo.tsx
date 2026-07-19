import React from "react";
import {
  AbsoluteFill,
  Audio,
  CalculateMetadataFunction,
  interpolate,
  OffthreadVideo,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Edl, EdlTransition, EdlVideoSegment } from "../pipeline/types";
import { TextOverlay } from "./components/TextOverlay";
import { ImageOverlay } from "./components/ImageOverlay";
import { VideoOverlay } from "./components/VideoOverlay";
import { TitleCard } from "./components/TitleCard";
import { Captions } from "./components/Captions";

/**
 * The generic EDL renderer. This single composition renders ANY finished
 * video: the entire format-specific structure arrives as data (the EDL),
 * never as code. New format = new config, not new components here —
 * except when a format references a new reusable component by name, which
 * gets added to the registry below and becomes available to every format.
 */

/** Overlay component registry — the names format configs may reference. */
const OVERLAY_COMPONENTS: Record<
  string,
  React.FC<Record<string, unknown>>
> = {
  TextOverlay: TextOverlay as React.FC<Record<string, unknown>>,
  ImageOverlay: ImageOverlay as React.FC<Record<string, unknown>>,
  VideoOverlay: VideoOverlay as React.FC<Record<string, unknown>>,
  TitleCard: TitleCard as React.FC<Record<string, unknown>>,
};

/**
 * v1 transitions act on the incoming segment (no overlapping video needed):
 *   cut (default) — nothing; fade — from black; whooshZoom — scale punch.
 */
const IncomingTransition: React.FC<{
  transition?: EdlTransition;
  children: React.ReactNode;
}> = ({ transition, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (!transition) return <>{children}</>;
  const durationFrames = Math.max(1, Math.round(transition.durationSec * fps));
  const progress = interpolate(frame, [0, durationFrames], [0, 1], {
    extrapolateRight: "clamp",
  });

  if (transition.component === "fade") {
    return <AbsoluteFill style={{ opacity: progress }}>{children}</AbsoluteFill>;
  }
  if (transition.component === "whooshZoom") {
    const scale = interpolate(progress, [0, 1], [1.18, 1]);
    return (
      <AbsoluteFill style={{ transform: `scale(${scale})` }}>
        {children}
      </AbsoluteFill>
    );
  }
  return <>{children}</>;
};

const Segment: React.FC<{ seg: EdlVideoSegment; transition?: EdlTransition }> = ({
  seg,
  transition,
}) => {
  const { fps } = useVideoConfig();
  return (
    <IncomingTransition transition={transition}>
      <OffthreadVideo
        src={staticFile(seg.src)}
        muted={seg.muted}
        startFrom={Math.round(seg.srcInSec * fps)}
        endAt={Math.round(seg.srcOutSec * fps)}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </IncomingTransition>
  );
};

export const EdlVideo: React.FC<{ edl: Edl }> = ({ edl }) => {
  const { fps } = useVideoConfig();
  const toFrames = (sec: number) => Math.round(sec * fps);

  // A transition after block N plays on the segment that follows it.
  const incomingTransitions = new Map<string, EdlTransition>();
  for (const t of edl.transitions) {
    const i = edl.video.findIndex((v) => v.blockId === t.afterBlockId);
    const next = edl.video[i + 1];
    if (next) incomingTransitions.set(next.blockId, t);
  }

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {edl.video.map((seg) => (
        <Sequence
          key={seg.blockId}
          from={toFrames(seg.tlInSec)}
          durationInFrames={toFrames(seg.tlOutSec) - toFrames(seg.tlInSec)}
          name={`video:${seg.blockId}`}
        >
          <Segment seg={seg} transition={incomingTransitions.get(seg.blockId)} />
        </Sequence>
      ))}

      {edl.overlays.map((overlay) => {
        const Component = OVERLAY_COMPONENTS[overlay.component];
        if (!Component) {
          console.warn(`EdlVideo: unknown overlay component "${overlay.component}"`);
          return null;
        }
        return (
          <Sequence
            key={overlay.id}
            from={toFrames(overlay.tlInSec)}
            durationInFrames={toFrames(overlay.tlOutSec) - toFrames(overlay.tlInSec)}
            name={`overlay:${overlay.id}`}
          >
            <Component {...overlay.params} />
          </Sequence>
        );
      })}

      {edl.captions.length > 0 && (
        <Captions
          groups={edl.captions}
          position={String(edl.captionStyle?.params.position ?? "lowerThird")}
        />
      )}

      {edl.sfx.map((s) => (
        <Sequence
          key={s.id}
          from={toFrames(s.tlInSec)}
          durationInFrames={
            s.durationSec !== undefined
              ? Math.max(1, toFrames(s.tlInSec + s.durationSec) - toFrames(s.tlInSec))
              : undefined
          }
          name={`sfx:${s.id}`}
        >
          <Audio src={staticFile(s.src)} volume={() => s.volume} />
        </Sequence>
      ))}

      {edl.music && (
        <Audio src={staticFile(edl.music.src)} volume={() => edl.music!.volume} />
      )}
    </AbsoluteFill>
  );
};

/** Duration, fps, and canvas size all come from the EDL itself. */
export const calculateEdlMetadata: CalculateMetadataFunction<{ edl: Edl }> = ({
  props,
}) => ({
  durationInFrames: Math.max(1, Math.round(props.edl.durationSec * props.edl.fps)),
  fps: props.edl.fps,
  width: props.edl.width,
  height: props.edl.height,
});

import React, { useMemo } from "react";
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

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** Frame-aware volume envelope for one music bed — fade-in/out at the
 *  bed's own head/tail, plus a ramped (not stepped) duck under every
 *  voice-block window in `duckWindows` (see schemas.ts's EdlMusicSchema
 *  doc comment). `frame` is LOCAL to the bed's own Sequence (0 at the
 *  bed's own tlInSec), matching what Remotion's Audio `volume` callback
 *  receives. Windows are assumed non-overlapping (voice blocks don't
 *  overlap each other); only the first match applies. */
const DUCK_RAMP_SEC = 0.25;
const musicVolumeAt = (music: Edl["music"][number], fps: number) => (frame: number): number => {
  const tSec = music.tlInSec + frame / fps;
  const endSec = music.durationSec !== undefined ? music.tlInSec + music.durationSec : undefined;

  let mult = 1;
  if (music.fadeInSec > 0) {
    mult *= clamp01((tSec - music.tlInSec) / music.fadeInSec);
  }
  if (music.fadeOutSec > 0 && endSec !== undefined) {
    mult *= clamp01((endSec - tSec) / music.fadeOutSec);
  }

  for (const w of music.duckWindows) {
    if (tSec < w.tlInSec - DUCK_RAMP_SEC || tSec > w.tlOutSec + DUCK_RAMP_SEC) continue;
    if (tSec < w.tlInSec) {
      mult *= 1 - (1 - music.duckVolume) * clamp01((tSec - (w.tlInSec - DUCK_RAMP_SEC)) / DUCK_RAMP_SEC);
    } else if (tSec > w.tlOutSec) {
      mult *= music.duckVolume + (1 - music.duckVolume) * clamp01((tSec - w.tlOutSec) / DUCK_RAMP_SEC);
    } else {
      mult *= music.duckVolume;
    }
    break;
  }

  // mult (fade/duck envelope) is already 0..1 from the clamp01 calls above —
  // don't clamp the product too, or a boosted music.volume (>1, +dB gain)
  // would get capped right back down to unity.
  return music.volume * mult;
};
import { ensureDisplayFonts } from "./fonts";
import { previewProxySrc } from "./previewSrc";
import { TextOverlay } from "./components/TextOverlay";
import { ImageOverlay } from "./components/ImageOverlay";
import { VideoOverlay } from "./components/VideoOverlay";
import { CutawayOverlay } from "./components/CutawayOverlay";
import { StickerTitle } from "./components/StickerTitle";
import { SkillCard } from "./components/SkillCard";
import { TierBoard } from "./components/TierBoard";
import { Captions } from "./components/Captions";
import { KaraokeTitleLayer } from "./components/KaraokeTitleLayer";
import { TriptychNameStamp } from "./components/TriptychNameStamp";
import { DEFAULT_MOTION_BY_COMPONENT, MotionWrapper } from "./components/Motion";

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
  CutawayOverlay: CutawayOverlay as React.FC<Record<string, unknown>>,
  StickerTitle: StickerTitle as React.FC<Record<string, unknown>>,
  SkillCard: SkillCard as React.FC<Record<string, unknown>>,
  TriptychNameStamp: TriptychNameStamp as React.FC<Record<string, unknown>>,
  TierBoard: TierBoard as React.FC<Record<string, unknown>>,
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

/** The karaokeTitle fg-alpha layer (matte.ts's compositeSubjectAlphaVideo)
 *  for ONE video segment — subject + desk foreground, transparent
 *  elsewhere, sitting ABOVE the karaoke title so the subject's own
 *  opaque pixels occlude it (see EdlVideo.tsx's own render-order doc
 *  comment). No `muted`/`volume` handling: this layer never carries
 *  audio (compositeSubjectAlphaVideo never encodes an audio track), and
 *  the base Segment for the SAME clip already plays the real audio. */
const FgLayer: React.FC<{ src: string; srcInSec: number; srcOutSec: number; jobId: string; previewMode?: boolean }> = ({
  src,
  srcInSec,
  srcOutSec,
  jobId,
  previewMode,
}) => {
  const { fps } = useVideoConfig();
  const resolvedSrc = previewMode ? previewProxySrc(jobId, src) : staticFile(src);
  return (
    <OffthreadVideo
      src={resolvedSrc}
      muted
      startFrom={Math.round(srcInSec * fps)}
      endAt={Math.round(srcOutSec * fps)}
      // Muted, so it never pauses the preview: see the note under Segment.
      pauseWhenBuffering={!previewMode}
      style={{ width: "100%", height: "100%", objectFit: "cover" }}
      transparent
    />
  );
};

/** How long a segment's own audio fades in/out at its two edges — masks the
 *  hard-cut audio pop an internal cut (select.ts, or several standalone
 *  takes laid back to back) otherwise produces at a boundary that isn't a
 *  real silence. Applied to EVERY segment's own edges uniformly (not only
 *  an internal cut) rather than threading through "is this an internal
 *  boundary" — 30ms is inaudible as a fade on an ordinary block-to-block
 *  hard cut, so this is a no-op there in practice. */
const SEGMENT_AUDIO_FADE_SEC = 0.03;

/** `seg.volume` ramped to 0 over the first/last SEGMENT_AUDIO_FADE_SEC of
 *  this segment's own LOCAL timeline (frame 0 = this segment's own
 *  Sequence start, per Remotion's volume-callback contract) — see
 *  SEGMENT_AUDIO_FADE_SEC's own doc comment. */
const segmentVolumeAt = (baseVolume: number, fps: number, durationInFrames: number) => (frame: number): number => {
  const fadeFrames = Math.max(1, Math.round(SEGMENT_AUDIO_FADE_SEC * fps));
  const fadeIn = clamp01(frame / fadeFrames);
  const fadeOut = clamp01((durationInFrames - 1 - frame) / fadeFrames);
  return baseVolume * Math.min(fadeIn, fadeOut);
};

const Segment: React.FC<{
  seg: EdlVideoSegment;
  transition?: EdlTransition;
  jobId: string;
  previewMode?: boolean;
}> = ({ seg, transition, jobId, previewMode }) => {
  const { fps } = useVideoConfig();
  const src = previewMode ? previewProxySrc(jobId, seg.src) : staticFile(seg.src);
  const durationInFrames = Math.max(1, Math.round((seg.tlOutSec - seg.tlInSec) * fps));
  return (
    <IncomingTransition transition={transition}>
      {/* seg.zoom (assemble.ts's internalCutZoom) — a static punch-in on
          alternating segments of a multi-take block, the ordinary way to
          hide a same-setting jump cut having no real camera movement of
          its own. 1 for every ordinary/single-take segment: a plain,
          unscaled AbsoluteFill, zero visual change. */}
      <AbsoluteFill style={seg.zoom !== 1 ? { transform: `scale(${seg.zoom})` } : undefined}>
        <OffthreadVideo
          src={src}
          muted={seg.muted}
          volume={segmentVolumeAt(seg.volume, fps, durationInFrames)}
          // A boosted volume (>1, i.e. +dB gain in the Inspector) is inaudible
          // through the plain HTML <video> element the Player otherwise uses
          // — its native `.volume` is hard-clamped to 1 by the browser, no
          // matter what's assigned to it. Routing through a Web Audio
          // GainNode (preview only; export mixes audio via ffmpeg separately
          // and doesn't go through this DOM element at all) is what actually
          // lets it exceed unity.
          useWebAudioApi={previewMode}
          // A sped-up segment consumes its whole source span across a
          // proportionally shorter timeline span — assemble.ts already
          // divided tlOutSec-tlInSec by the same number, so startFrom stays
          // in SOURCE frames and playbackRate is what reconciles the two.
          // 1 for every ordinary segment.
          //
          // endAt is NOT a source frame: Remotion makes the clip visible for
          // (endAt - startFrom) frames of the OUTPUT timeline, unscaled by
          // playbackRate. In source frames, a clip slowed to 0.8x showed
          // only 80% of its slot and then went black (the segment itself was
          // fine). So it is startFrom plus the segment's own length on the
          // timeline, which at 1x is the same number as before.
          playbackRate={seg.speed}
          startFrom={Math.round(seg.srcInSec * fps)}
          endAt={Math.round(seg.srcInSec * fps) + durationInFrames}
          pauseWhenBuffering={!(previewMode && seg.muted)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>
    </IncomingTransition>
  );
};

/* Why a muted segment never pauses the preview (pauseWhenBuffering above):
 * OffthreadVideo defaults to pausing the whole Player while its element
 * buffers, and every such pause suspends the Player's shared AudioContext.
 * Resuming waits until the audio output clock actually moves again, which
 * was measured at 50ms to 1.2s, with the picture frozen the whole time.
 * Meanwhile the other <video> elements keep playing and drift past
 * Remotion's acceptable time shift, so it re-seeks them, which buffers
 * again: a loop that froze an AI video's preview for seconds at a cut. A
 * muted clip has no audio to keep in sync, so letting it catch up on its
 * own (a frame or two held during a ~20ms seek) is invisible, and breaks
 * the loop. A segment with its own audio still pauses, as before. Export
 * is unaffected: rendering waits for every frame regardless. */

/** One overlay's own lifetime — a plain function of (frame, overlay), same
 *  requirement every other per-frame render here already meets. Needs its
 *  own component (not inline JSX inside .map()) purely so it can call
 *  useCurrentFrame()/useVideoConfig() per React's hook rules, same reason
 *  Segment/FgLayer are their own components above. Merges overlay.params
 *  with every state whose atSec has passed (assemble.ts pre-sorts
 *  ascending; later states win) — mirrors Captions.tsx's own absolute-time
 *  window lookup. overlay.states is always [] for a format that doesn't
 *  author any, so this is a no-op loop and params===overlay.params for
 *  every overlay that exists today. */
const OverlayInstance: React.FC<{ overlay: Edl["overlays"][number]; jobId: string; previewMode?: boolean }> = ({
  overlay,
  jobId,
  previewMode,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const tSec = overlay.tlInSec + frame / fps;
  let params = overlay.params;
  for (const s of overlay.states) {
    if (tSec >= s.atSec) params = { ...params, ...s.params };
  }
  const Component = OVERLAY_COMPONENTS[overlay.component];
  if (!Component) {
    console.warn(`EdlVideo: unknown overlay component "${overlay.component}"`);
    return null;
  }
  const totalDurationInFrames = Math.round((overlay.tlOutSec - overlay.tlInSec) * fps);
  return (
    <div
      style={{
        position: "absolute",
        left: `${overlay.x * 100}%`,
        top: `${overlay.y * 100}%`,
        width: `${overlay.width * 100}%`,
        height: `${overlay.height * 100}%`,
      }}
    >
      <MotionWrapper
        motion={overlay.motion ?? DEFAULT_MOTION_BY_COMPONENT[overlay.component]}
        totalDurationInFrames={totalDurationInFrames}
      >
        {/* jobId/previewMode are only consumed by the two overlay
            components that embed a video (VideoOverlay, CutawayOverlay —
            see their own doc comments); boxWidthPx/boxHeightPx only by
            TextOverlay (see its own doc comment); every other registered
            component just ignores whichever extra props it doesn't use.
            Without jobId/previewMode they fell back to staticFile(),
            live-decoding the original (often 4K) source in the browser
            instead of the small preview proxy every OTHER video element
            in this composition already uses. */}
        <Component {...params} jobId={jobId} previewMode={previewMode} boxWidthPx={overlay.width * width} boxHeightPx={overlay.height * height} />
      </MotionWrapper>
    </div>
  );
};

/** CSS approximation of the StyleProfile grade (see schemas.ts's GradeSchema
 *  doc comment) — cheap, GPU-free color-matching applied uniformly across
 *  every video segment (real footage and generated inserts alike), unlike
 *  generation/provider.ts's ffmpeg grade which only ever reached generated
 *  stills. Deliberately scoped to just the video stack below, not text
 *  overlays/captions, so a red title stays pure red under a cool grade. */
const gradeFilter = (grade: Edl["grade"]): string | undefined => {
  if (!grade) return undefined;
  const brightnessMultiplier = 1 + grade.brightness;
  // No native CSS "temperature" filter; hue-rotate is a rough stand-in —
  // negative temperatureShift (cooler) rotates toward blue.
  const hueRotateDeg = grade.temperatureShift * -12;
  return `brightness(${brightnessMultiplier}) contrast(${grade.contrast}) saturate(${grade.saturation}) hue-rotate(${hueRotateDeg}deg)`;
};

/** How far ahead of its own start a preview-mode Sequence mounts its child
 *  — long enough to cover a preview-proxy request (an API round trip, plus
 *  ffmpeg transcode time on a cache miss) and a fresh <video> element's own
 *  fetch/seek/decoder warm-up, without premounting so many elements at once
 *  that concurrent decode load becomes the new bottleneck. The previous
 *  0.75s budget wasn't enough headroom for a still-warming cache, which
 *  showed up as a stall right at the cut. Export never premounts (ffmpeg
 *  frame extraction has no equivalent warm-up cost). */
const PREVIEW_PREMOUNT_SEC = 2;

export const EdlVideo: React.FC<{ edl: Edl; previewMode?: boolean }> = ({ edl, previewMode }) => {
  // Root-level, not per-component: SYSTEM_FONT's Inter has to be present
  // for every frame regardless of which overlays that frame contains (see
  // fonts.ts's own doc comment).
  ensureDisplayFonts();
  const { fps } = useVideoConfig();
  const toFrames = (sec: number) => Math.round(sec * fps);
  const filter = gradeFilter(edl.grade);

  // A transition after clip N plays on the segment that follows it.
  const incomingTransitions = useMemo(() => {
    const map = new Map<string, EdlTransition>();
    for (const t of edl.transitions) {
      const i = edl.video.findIndex((v) => v.id === t.afterClipId);
      const next = edl.video[i + 1];
      if (next) map.set(next.id, t);
    }
    return map;
  }, [edl.transitions, edl.video]);

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <AbsoluteFill style={{ filter }}>
        {edl.video.map((seg) => (
          <Sequence
            key={seg.id}
            from={toFrames(seg.tlInSec)}
            durationInFrames={toFrames(seg.tlOutSec) - toFrames(seg.tlInSec)}
            name={`video:${seg.id}`}
            premountFor={previewMode ? Math.round(fps * PREVIEW_PREMOUNT_SEC) : 0}
          >
            <Segment seg={seg} transition={incomingTransitions.get(seg.id)} jobId={edl.jobId} previewMode={previewMode} />
          </Sequence>
        ))}
      </AbsoluteFill>

      {/* karaokeTitle + its fg-alpha layer: title BEHIND, subject ON TOP
         — see schemas.ts's captionVariant doc comment and matte.ts's
         compositeSubjectAlphaVideo. Positioned here, between the base
         video and the ordinary overlays/captions below, so a titled
         block's own head genuinely occludes the letters rather than the
         title sitting flat in front of (or fully behind) the whole frame. */}
      {edl.captions.some((g) => g.variant === "karaokeTitle") && (
        <KaraokeTitleLayer groups={edl.captions} baselineFrac={edl.karaokeTitleBaselineFrac} />
      )}
      {edl.video
        .filter((seg) => seg.fgSrc)
        .map((seg) => (
          <Sequence
            key={`fg:${seg.id}`}
            from={toFrames(seg.tlInSec)}
            durationInFrames={toFrames(seg.tlOutSec) - toFrames(seg.tlInSec)}
            name={`fg:${seg.id}`}
            premountFor={previewMode ? Math.round(fps * PREVIEW_PREMOUNT_SEC) : 0}
          >
            <FgLayer src={seg.fgSrc!} srcInSec={seg.srcInSec} srcOutSec={seg.srcOutSec} jobId={edl.jobId} previewMode={previewMode} />
          </Sequence>
        ))}

      {edl.overlays.map((overlay) => (
        <Sequence
          key={overlay.id}
          from={toFrames(overlay.tlInSec)}
          durationInFrames={toFrames(overlay.tlOutSec) - toFrames(overlay.tlInSec)}
          name={`overlay:${overlay.id}`}
          premountFor={previewMode ? Math.round(fps * PREVIEW_PREMOUNT_SEC) : 0}
        >
          <OverlayInstance overlay={overlay} jobId={edl.jobId} previewMode={previewMode} />
        </Sequence>
      ))}

      {edl.captions.length > 0 && (
        <Captions
          groups={edl.captions}
          position={String(edl.captionStyle?.params.position ?? "lowerThird")}
          theme={edl.captionStyle?.params.theme as string | undefined}
        />
      )}

      {edl.voiceovers.map((v) => (
        <Sequence
          key={v.id}
          from={toFrames(v.tlInSec)}
          durationInFrames={Math.max(1, toFrames(v.tlOutSec) - toFrames(v.tlInSec))}
          name={`voiceover:${v.id}`}
          // Loaded before its line starts, like the video segments: an AI
          // video is a dozen back-to-back voice lines, and one mounting
          // only at its own start reaches the speaker late and gets re-seeked.
          premountFor={previewMode ? Math.round(fps * PREVIEW_PREMOUNT_SEC) : 0}
        >
          <Audio
            src={previewMode ? previewProxySrc(edl.jobId, v.src) : staticFile(v.src)}
            volume={() => v.volume}
            // See Segment's own useWebAudioApi doc comment — same reason.
            useWebAudioApi={previewMode}
            trimBefore={toFrames(v.srcInSec)}
          />
        </Sequence>
      ))}

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
          <Audio
            src={staticFile(s.src)}
            volume={() => s.volume}
            // See Segment's own useWebAudioApi doc comment — same reason.
            useWebAudioApi={previewMode}
            trimBefore={toFrames(s.srcInSec)}
          />
        </Sequence>
      ))}

      {edl.music.map((m) => (
        <Sequence
          key={m.id}
          from={toFrames(m.tlInSec)}
          durationInFrames={
            m.durationSec !== undefined
              ? Math.max(1, toFrames(m.tlInSec + m.durationSec) - toFrames(m.tlInSec))
              : undefined
          }
          name={`music:${m.id}`}
        >
          <Audio
            src={staticFile(m.src)}
            volume={musicVolumeAt(m, fps)}
            // See Segment's own useWebAudioApi doc comment — same reason.
            useWebAudioApi={previewMode}
            trimBefore={toFrames(m.srcInSec)}
            // The bed's own natural length may be shorter than
            // m.durationSec (see assemble.ts's buildMusic) — looping
            // fills the remainder with a repeat instead of leaving true
            // silence for however much is left over.
            loop
          />
        </Sequence>
      ))}
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

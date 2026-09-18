"use client";

import { useEffect, useRef, useState } from "react";

/** Maps a raw pipeline artifact name (as written by run.ts's `write()` — see
 *  build/route.ts's stdout scrape) to copy a user can actually read. Also
 *  used for the "Building… (…)" button label, so the two stay in sync. */
const STAGE_LABELS: Record<string, string> = {
  queued: "Getting things ready",
  filled: "Reading your footage",
  discovered: "Finding your best takes",
  splitTake: "Splitting your take into lines",
  format: "Matching footage to your script",
  inserts: "Generating extra shots",
  namesTake: "Pulling out name mentions",
  transcript: "Transcribing your footage",
  trim: "Trimming the dead air",
  matte: "Cutting out your background",
  roles: "Matching voices to your blocks",
  edl: "Assembling your edit",
};

export function friendlyStageLabel(stage: string | null): string {
  if (!stage) return "Processing your footage";
  return STAGE_LABELS[stage] ?? "Processing your footage";
}

export type FootageClip = {
  url: string;
  mediaType: "video" | "image";
  label: string;
};

// However much footage a job actually has bound, only this many take a seat
// in the deck — matches how many a hand of cards can fan out and still read
// as individual shots instead of a smear. The rest of footageClips (already
// capped at 16 upstream) simply never gets pulled to the front.
const DECK_MAX = 7;
// How often the front card retires into the fan and the next one is drawn —
// slow enough to actually look at each clip, since this plays over a wait
// that's measured in minutes, not milliseconds.
const DECK_CYCLE_MS = 2600;

/** Rotates a `[0..size)` index deck every DECK_CYCLE_MS so a new clip takes
 *  the front position — the array itself (not any element's identity)
 *  changes, so each card keeps its own key and CSS transitions smoothly
 *  from its old fan slot to its new one instead of swapping content in
 *  place. Deliberately NOT gated on reduced motion: which clip is featured
 *  is content, not decoration, and freezing it entirely would mean a
 *  reduced-motion visitor watches the exact same single frame for the
 *  whole build — worse than the instant, transition-less snap between
 *  clips that reduced motion actually gets here (see globals.css, which
 *  zeroes .processing-deck__card's transition in that media query; the
 *  *sliding* is what's suppressed, not the cycling itself). Frozen only
 *  when there's truly nowhere to cycle to (a single-card deck). */
function useDeckOrder(size: number, enabled: boolean): number[] {
  const [order, setOrder] = useState<number[]>(() =>
    Array.from({ length: size }, (_, i) => i),
  );
  useEffect(() => {
    setOrder(Array.from({ length: size }, (_, i) => i));
  }, [size]);
  useEffect(() => {
    if (!enabled || size < 2) return;
    const t = setInterval(() => {
      setOrder((prev) => [...prev.slice(1), prev[0]]);
    }, DECK_CYCLE_MS);
    return () => clearInterval(t);
  }, [enabled, size]);
  return order;
}

/** Where a card sits: slot 0 is the drawn/front card (large, crisp, popped
 *  up and to the right); slots 1+ are the fanned deck behind it, spread by
 *  rotation around a pivot below the card so they read as a held hand of
 *  photos, dimming and softening slightly toward the outer edges of the
 *  fan for a touch of depth. */
function deckCardStyle(slot: number, deckSize: number): React.CSSProperties {
  if (slot === 0) {
    return {
      transform: "translate3d(26%, -18%, 60px) rotate(-4deg) scale(1.15)",
      opacity: 1,
      filter: "blur(0px)",
      zIndex: 50,
    };
  }
  const backCount = deckSize - 1;
  const mid = (backCount + 1) / 2;
  const dist = Math.abs(slot - mid);
  const angle = (slot - mid) * 11;
  return {
    transform: `translate3d(0, 3%, ${-dist * 14}px) rotate(${angle}deg) scale(${0.82 - dist * 0.02})`,
    opacity: Math.max(0.45, 0.92 - dist * 0.12),
    filter: `blur(${Math.min(2, dist * 0.6)}px)`,
    zIndex: 40 - Math.round(dist * 3),
  };
}

/** Keeps the whole deck alive in 3D even when nobody's touching it: a slow
 *  sinusoidal drift on rotateX/rotateY runs every frame regardless of
 *  device, so the fan is never actually still (the 2.6s reorder was the
 *  only thing moving before this — everything else sat frozen in between,
 *  which read as static rather than "processing"). On top of that drift,
 *  desktop pointer movement over the whole modal (not just the small deck
 *  box — a target that size was too easy to miss) adds a lerped tilt, per
 *  emil-design-eng's guidance to smooth decorative mouse-tracking rather
 *  than snap straight to the cursor. Pointer response is gated to
 *  hover:hover + pointer:fine; the idle drift itself runs everywhere except
 *  under reduced motion, where the whole effect is skipped. */
function useDeckLife(
  hoverAreaRef: React.RefObject<HTMLDivElement | null>,
  stageRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
) {
  useEffect(() => {
    const hoverArea = hoverAreaRef.current;
    const stage = stageRef.current;
    if (!enabled || !stage) return;

    const canHover = hoverArea
      ? window.matchMedia("(hover: hover) and (pointer: fine)").matches
      : false;

    let targetX = 0;
    let targetY = 0;
    let curX = 0;
    let curY = 0;
    let raf = 0;
    const start = performance.now();

    const onMove = (e: PointerEvent) => {
      if (!hoverArea) return;
      const rect = hoverArea.getBoundingClientRect();
      targetX = (e.clientX - rect.left) / rect.width - 0.5;
      targetY = (e.clientY - rect.top) / rect.height - 0.5;
    };
    const onLeave = () => {
      targetX = 0;
      targetY = 0;
    };
    const tick = (now: number) => {
      const t = (now - start) / 1000;
      // Two out-of-phase sine waves (different periods) so the drift
      // doesn't read as a simple back-and-forth metronome.
      const idleX = Math.sin(t / 2.2) * 0.09;
      const idleY = Math.sin(t / 3.1 + 1) * 0.06;
      curX += (targetX + idleX - curX) * 0.06;
      curY += (targetY + idleY - curY) * 0.06;
      stage.style.transform = `rotateX(${curY * -12}deg) rotateY(${curX * 16}deg)`;
      raf = requestAnimationFrame(tick);
    };

    if (canHover && hoverArea) {
      hoverArea.addEventListener("pointermove", onMove);
      hoverArea.addEventListener("pointerleave", onLeave);
    }
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (canHover && hoverArea) {
        hoverArea.removeEventListener("pointermove", onMove);
        hoverArea.removeEventListener("pointerleave", onLeave);
      }
      stage.style.transform = "";
    };
  }, [hoverAreaRef, stageRef, enabled]);
}

/** No framer-motion in this app (see package.json) to lean on for this, so
 *  it's a plain matchMedia listener. Used to also stop the deck's
 *  autoplaying <video> thumbnails under reduced motion — the CSS media
 *  query alone only stops the cycling/breathe/tilt animations, not actual
 *  video playback, which is motion just the same. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

// The overlay's own fade/scale transition — kept in JS too so the unmount
// timer waits exactly as long as the CSS transition takes to finish,
// instead of either cutting it off mid-animation or leaving a hidden node
// sitting around after it's done.
const TRANSITION_MS = 240;

/** Full-screen takeover shown while continueToEditor()'s build is in
 *  flight (see ResourcesBoard). The build is a background subprocess that
 *  can take minutes, so this is a genuine wait — worth a real animation,
 *  unlike the sub-300ms micro-interactions elsewhere in the wizard. */
export function ProcessingOverlay({
  active,
  stage,
  clips,
}: {
  active: boolean;
  stage: string | null;
  /** The actual footage bound so far (see ResourcesBoard's footageClips) —
   *  shown as a fanned, cycling deck so the wait feels tied to *this* job's
   *  own clips instead of a generic spinner. Falls back to the plain ring
   *  when a format has nothing visual bound (e.g. text-only slots). */
  clips: FootageClip[];
}) {
  // Stays mounted for TRANSITION_MS after `active` goes false so it can
  // animate out — the success path never actually sees this, since
  // continueToEditor() navigates to /edit the moment the build finishes;
  // this only matters for the diagnostics/error paths, which stay on this
  // page with the overlay closing behind them.
  const [mounted, setMounted] = useState(active);
  const [shown, setShown] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (active) {
      setMounted(true);
      // Two rAFs: the first lets the "hidden" starting styles actually
      // paint once before the second flips `shown`, so the browser has
      // something to transition from instead of collapsing both states
      // into the same frame and skipping the animation.
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
    setShown(false);
    closeTimer.current = setTimeout(() => setMounted(false), TRANSITION_MS);
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, [active]);

  // Crossfades the stage label instead of snapping it whenever the
  // pipeline moves on to a new stage (see emil-design-eng's blur-crossfade
  // pattern) — a plain text swap mid-word looked like a glitch.
  const label = friendlyStageLabel(stage);
  const [displayLabel, setDisplayLabel] = useState(label);
  const [labelBlurred, setLabelBlurred] = useState(false);

  useEffect(() => {
    if (label === displayLabel) return;
    setLabelBlurred(true);
    const t = setTimeout(() => {
      setDisplayLabel(label);
      setLabelBlurred(false);
    }, 150);
    return () => clearTimeout(t);
  }, [label, displayLabel]);

  const reducedMotion = usePrefersReducedMotion();

  const deckClips = clips.slice(0, DECK_MAX);
  const deckSize = deckClips.length;
  const order = useDeckOrder(deckSize, active);
  const modalRef = useRef<HTMLDivElement>(null);
  const deckStageRef = useRef<HTMLDivElement>(null);
  useDeckLife(modalRef, deckStageRef, active && !reducedMotion);

  if (!mounted) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--bg)]/80 backdrop-blur-md transition-opacity ease-[var(--ease-out)]"
      style={{
        opacity: shown ? 1 : 0,
        transitionDuration: `${TRANSITION_MS}ms`,
      }}
      role="status"
      aria-live="polite"
    >
      <div
        ref={modalRef}
        className="flex w-[min(92vw,560px)] flex-col items-center gap-7 rounded-3xl border border-[color:var(--card-border)] bg-[color:var(--bg-2)]/95 px-8 py-12 text-center shadow-[0_40px_120px_rgba(76,29,149,0.35)] transition-[transform,opacity] ease-[var(--ease-out)] sm:px-12"
        style={{
          opacity: shown ? 1 : 0,
          transform: shown ? "scale(1)" : "scale(0.95)",
          transitionDuration: `${TRANSITION_MS}ms`,
        }}
      >
        {deckSize > 0 ? (
          <div className="processing-deck" aria-hidden="true">
            <div className="processing-deck__stage" ref={deckStageRef}>
              {deckClips.map((clip, i) => {
                const slot = order.indexOf(i);
                if (slot === -1) return null;
                return (
                  <div
                    key={clip.url + i}
                    className="processing-deck__card"
                    data-front={slot === 0 || undefined}
                    style={deckCardStyle(slot, deckSize)}
                  >
                    <div
                      className="processing-deck__card-inner"
                      style={{ "--i": i } as React.CSSProperties}
                    >
                      {clip.mediaType === "video" ? (
                        <video
                          src={clip.url}
                          muted
                          playsInline
                          preload="metadata"
                          autoPlay={!reducedMotion}
                          loop={!reducedMotion}
                        />
                      ) : (
                        <img src={clip.url} alt="" />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="processing-ring">
            <div className="processing-ring__hub">
              <div className="processing-ring__pulse">
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="8.5"
                    stroke="var(--accent)"
                    strokeWidth="1.5"
                  />
                  <circle cx="12" cy="12" r="1.4" fill="var(--accent)" />
                  <circle cx="12" cy="6.2" r="1.3" fill="var(--accent)" />
                  <circle cx="17" cy="9.4" r="1.3" fill="var(--accent)" />
                  <circle cx="17" cy="14.6" r="1.3" fill="var(--accent)" />
                  <circle cx="12" cy="17.8" r="1.3" fill="var(--accent)" />
                  <circle cx="7" cy="14.6" r="1.3" fill="var(--accent)" />
                  <circle cx="7" cy="9.4" r="1.3" fill="var(--accent)" />
                </svg>
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-col items-center gap-2">
          <p
            className="font-[family-name:var(--font-display)] text-lg font-bold text-[color:var(--ink)] transition-[filter,opacity] duration-150 ease-out"
            style={{
              filter: labelBlurred ? "blur(3px)" : "blur(0px)",
              opacity: labelBlurred ? 0.4 : 1,
            }}
          >
            {displayLabel}
          </p>
          <p className="max-w-[320px] text-sm text-[color:var(--ink-dim)]">
            This usually takes a minute or two — feel free to leave this tab
            open, we&apos;ll take you to the editor the moment it&apos;s ready.
          </p>
        </div>

        <div className="processing-track">
          <div className="processing-track__runner" />
        </div>
      </div>
    </div>
  );
}

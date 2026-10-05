"use client";

import { useEffect, useRef, useState } from "react";
import { copy, REELS } from "../landing-copy";
import { useInView } from "./LoopReel";
import { PHONE_WIDTH, REDUCED_MOTION, useMediaQuery } from "./useMediaQuery";

/** The reels differ in length (8 to 19 s). They all restart together at this mark so they stay in step. */
const LOOP_SEC = 8;
/** On a phone one reel shows at a time. */
const SLIDE_MS = 3600;

/**
 * The hero proof. Desktop: five phone frames started together, so the shared
 * framing, caption spot and pacing show at a glance. Phone: one frame that
 * crossfades through all five. Reduced motion: a swipeable row, nothing
 * autoplays, each video has its own controls.
 */
export function HeroWall() {
  const reduced = useMediaQuery(REDUCED_MOTION);
  const phone = useMediaQuery(PHONE_WIDTH);
  const [wall, inView] = useInView<HTMLDivElement>("0px");
  const videos = useRef<(HTMLVideoElement | null)[]>([]);
  const [active, setActive] = useState(0);
  const mode = reduced ? "row" : phone ? "single" : "wall";

  // Desktop: play everything together and restart together.
  useEffect(() => {
    if (mode !== "wall") return;
    const all = () => videos.current.filter((v): v is HTMLVideoElement => v !== null);
    if (!inView) {
      all().forEach((v) => v.pause());
      return;
    }
    const restart = () =>
      all().forEach((v) => {
        v.currentTime = 0;
        v.play().catch(() => {});
      });
    restart();
    const timer = setInterval(() => {
      const lead = videos.current[0];
      if (lead && lead.currentTime >= LOOP_SEC) restart();
    }, 120);
    return () => clearInterval(timer);
  }, [mode, inView]);

  // Phone: advance the visible reel.
  useEffect(() => {
    if (mode !== "single" || !inView) return;
    const timer = setInterval(() => setActive((i) => (i + 1) % REELS.length), SLIDE_MS);
    return () => clearInterval(timer);
  }, [mode, inView]);

  useEffect(() => {
    if (mode !== "single") return;
    videos.current.forEach((video, i) => {
      if (!video) return;
      if (i === active && inView) {
        video.currentTime = 0;
        video.play().catch(() => {});
      } else video.pause();
    });
  }, [mode, active, inView]);

  return (
    <div className="wallwrap">
      <p className="wall__handle">{copy.hero.wallHandle}</p>
      <div ref={wall} className={`wall wall--${mode}`}>
        {REELS.map((reel, i) => (
          <figure className="wall__item" key={reel.src} data-active={mode === "single" ? i === active : undefined}>
            <div className="phone">
              <video
                ref={(el) => {
                  videos.current[i] = el;
                }}
                src={reel.src}
                poster={reel.poster}
                muted
                playsInline
                preload={mode === "single" && i !== active ? "none" : "metadata"}
                controls={reduced}
              />
            </div>
            <figcaption className="wall__likes">
              <span aria-hidden="true">♥</span> {reel.likes} {copy.hero.likesSuffix}
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

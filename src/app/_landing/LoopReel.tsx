"use client";

import { useEffect, useRef, useState } from "react";
import { REDUCED_MOTION, useMediaQuery } from "./useMediaQuery";

/** True while the element is on screen. */
export function useInView<T extends Element>(margin = "120px"): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [margin]);
  return [ref, inView];
}

/**
 * A muted looping reel that plays only while it is on screen. With reduced
 * motion it shows its poster with the browser's own controls and never
 * starts by itself.
 */
export function LoopReel({
  src,
  poster,
  className,
  muted = true,
  videoRef,
}: {
  src: string;
  poster: string;
  className?: string;
  muted?: boolean;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
}) {
  const reduced = useMediaQuery(REDUCED_MOTION);
  const [wrap, inView] = useInView<HTMLDivElement>();
  const own = useRef<HTMLVideoElement>(null);
  const ref = videoRef ?? own;

  useEffect(() => {
    const video = ref.current;
    if (!video || reduced) return;
    if (inView) video.play().catch(() => {});
    else video.pause();
  }, [inView, reduced, ref]);

  return (
    <div ref={wrap} className="reel">
      <video
        ref={ref}
        className={className}
        src={src}
        poster={poster}
        muted={muted}
        loop
        playsInline
        preload="metadata"
        controls={reduced}
      />
    </div>
  );
}

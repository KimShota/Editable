"use client";

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useEffect, useRef, useState } from "react";
import { copy, REELS } from "../landing-copy";
import { useInView } from "./LoopReel";
import { REDUCED_MOTION, useMediaQuery } from "./useMediaQuery";

const STEPS = copy.sames.steps;
const FLOW = copy.sames.flow;

/** Reels 2 and 3 share their framing, caption spot and cuts, so one set of boxes fits both. */
const REEL_A = 2;
const REEL_B = 1;
const reelFor = (step: number): number => (step >= 3 ? REEL_B : REEL_A);

/** Where each flow beat ends, in seconds into the reel (measured from its cuts). */
const BEAT_ENDS = [2.73, 3.7, 6.13, Infinity];
const beatStart = (i: number): number => (i === 0 ? 0 : BEAT_ENDS[i - 1]);

/** Time in the reel → 0..1 along four equal-width beats. */
const playheadAt = (t: number, duration: number): { pos: number; beat: number } => {
  const beat = BEAT_ENDS.findIndex((end) => t < end);
  const i = beat === -1 ? FLOW.length - 1 : beat;
  const end = Number.isFinite(BEAT_ENDS[i]) ? BEAT_ENDS[i] : duration;
  const within = Math.min(1, Math.max(0, (t - beatStart(i)) / Math.max(0.01, end - beatStart(i))));
  return { pos: (i + within) / FLOW.length, beat: i };
};

/** The annotation boxes that sit on top of a reel for one "same". */
function Overlays({ step, flowRef, headRef }: { step: number; flowRef?: React.RefObject<HTMLDivElement | null>; headRef?: React.RefObject<HTMLElement | null> }) {
  return (
    <>
      <div className="ov ov--frame" data-on={step === 0}>
        <span className="ov__tag">{STEPS[0].tag}</span>
      </div>
      <div className="ov ov--caption" data-on={step === 1 || step === 3}>
        <span className="ov__tag">{step === 3 ? STEPS[3].tag : STEPS[1].tag}</span>
      </div>
      <div className="ov ov--figure" data-on={step === 2}>
        <span className="ov__tag">{STEPS[2].tag}</span>
      </div>
      <div className="ov ov--flow" data-on={step === 4}>
        <div className="flow" ref={flowRef} data-beat="0">
          {FLOW.map((name, i) => (
            <span className="flow__beat" key={name} data-i={i}>{name}</span>
          ))}
          <i className="flow__head" ref={headRef as React.RefObject<HTMLElement>} />
        </div>
      </div>
    </>
  );
}

/**
 * "What I never changed": a phone frame pinned while five annotations land one
 * by one on top of the reel (filming, editing, character, topic, flow).
 * Reduced motion: no pin, five static annotated stills.
 */
export function FiveSames() {
  const reduced = useMediaQuery(REDUCED_MOTION);
  const [step, setStep] = useState(0);
  const section = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [view, inView] = useInView<HTMLDivElement>("0px");
  const videos = useRef<(HTMLVideoElement | null)[]>([]);
  const flow = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLElement>(null);
  const reel = reelFor(step);

  useEffect(() => {
    if (reduced) return;
    gsap.registerPlugin(ScrollTrigger);
    const ctx = gsap.context(() => {
      ScrollTrigger.create({
        trigger: stage.current,
        start: "top top",
        end: () => `+=${window.innerHeight * 0.55 * STEPS.length}`,
        pin: true,
        invalidateOnRefresh: true,
        onUpdate: (self) => setStep(Math.min(STEPS.length - 1, Math.floor(self.progress * STEPS.length))),
      });
    }, section);
    return () => ctx.revert();
  }, [reduced]);

  // Only the reel for this step plays, and only while the stage is on screen.
  useEffect(() => {
    if (reduced) return;
    [REEL_A, REEL_B].forEach((index) => {
      const video = videos.current[index];
      if (!video) return;
      if (inView && index === reel) {
        video.currentTime = 0;
        video.play().catch(() => {});
      } else video.pause();
    });
  }, [reel, inView, reduced]);

  // The playhead of the flow timeline follows the reel.
  useEffect(() => {
    if (reduced || step !== 4 || !inView) return;
    let frame = 0;
    const tick = () => {
      const video = videos.current[reel];
      if (video && head.current && flow.current && Number.isFinite(video.duration)) {
        const { pos, beat } = playheadAt(video.currentTime, video.duration);
        head.current.style.left = `${pos * 100}%`;
        flow.current.dataset.beat = String(beat);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [step, reel, inView, reduced]);

  const header = (
    <div className="sames__head">
      <p className="kicker">{copy.sames.kicker}</p>
      <h2 className="sames__title">{copy.sames.title}</h2>
    </div>
  );

  if (reduced) {
    return (
      <section className="sames sames--static" id="method" ref={section}>
        <div className="sames__inner">
          {header}
          <div className="sames__cards">
            {STEPS.map((s, i) => (
              <figure className="sames__card" key={s.name}>
                <div className="phone">
                  <img src={REELS[reelFor(i)].poster} alt="" />
                  <Overlays step={i} />
                </div>
                <figcaption>
                  <h3>{s.name}</h3>
                  <p>{s.line}</p>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="sames" id="method" ref={section}>
      <div className="sames__stage" ref={stage}>
        {header}
        <div className="sames__body">
          <ol className="sames__list">
            {STEPS.map((s, i) => (
              <li key={s.name} data-active={i === step} data-done={i < step}>
                <span className="sames__num">0{i + 1}</span>
                <div>
                  <h3>{s.name}</h3>
                  <p>{s.line}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="sames__phonecol" ref={view}>
            <div className="phone phone--lg">
              {[REEL_A, REEL_B].map((index) => (
                <video
                  key={index}
                  ref={(el) => {
                    videos.current[index] = el;
                  }}
                  className="phone__video"
                  data-on={index === reel}
                  src={REELS[index].src}
                  poster={REELS[index].poster}
                  muted
                  loop
                  playsInline
                  preload="metadata"
                />
              ))}
              <Overlays step={step} flowRef={flow} headRef={head} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

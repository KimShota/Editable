"use client";

import { useRef, useState } from "react";
import { ASSETS, copy } from "../landing-copy";
import { LoopReel } from "./LoopReel";

/**
 * Proof the AI output is good. Left: the structure of a viral video, shown as
 * a blurred still with its real shot timeline (never its footage). Right:
 * Nova, Katalab's own character, recreating it, with sound on request.
 */
export function ProductPeek() {
  const p = copy.peek;
  const video = useRef<HTMLVideoElement>(null);
  const [sound, setSound] = useState(false);
  const total = p.beats.reduce((sum, beat) => sum + beat.sec, 0);

  const toggleSound = () => {
    const el = video.current;
    if (!el) return;
    el.muted = sound;
    setSound(!sound);
  };

  return (
    <section className="peek" id="peek">
      <div className="peek__inner">
        <h2 className="peek__title" data-reveal>{p.title}</h2>
        <p className="peek__sub" data-reveal>{p.sub}</p>

        <div className="peek__stage" data-reveal>
          <figure className="peek__col">
            <div className="phone phone--ghost">
              <img src={ASSETS.peekOriginal} alt="" />
              <ol className="beats" aria-label={p.original}>
                {p.beats.map((beat) => (
                  <li key={beat.name} style={{ flexGrow: beat.sec / total }}>
                    <span>{beat.name}</span>
                    <em>{beat.sec}s</em>
                  </li>
                ))}
              </ol>
            </div>
            <figcaption>
              <strong>{p.original}</strong>
              <span>{p.originalNote}</span>
            </figcaption>
          </figure>

          <div className="peek__arrow" aria-hidden="true">→</div>

          <figure className="peek__col">
            <div className="phone">
              <LoopReel src={ASSETS.novaVideo} poster={ASSETS.novaPoster} videoRef={video} muted />
              <button className="peek__sound" type="button" onClick={toggleSound} aria-pressed={sound}>
                {sound ? p.soundOff : p.soundOn}
              </button>
            </div>
            <figcaption>
              <strong>{p.recreation}</strong>
              <span>{p.recreationNote}</span>
            </figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}

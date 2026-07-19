"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import "./marketing.css";

/**
 * Marketing landing page. Ported from the standalone website/ static site
 * into the product's own Next.js app so "Launch app" is same-origin,
 * client-side navigation instead of a link out to a separate deploy.
 */
export default function Home() {
  const rootRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    gsap.registerPlugin(ScrollTrigger);

    const ctx = gsap.context(() => {
      const lenis = new Lenis({ lerp: 0.09, smoothWheel: true });
      lenis.on("scroll", ScrollTrigger.update);
      const lenisTick = (time: number) => lenis.raf(time * 1000);
      gsap.ticker.add(lenisTick);
      gsap.ticker.lagSmoothing(0);

      // Cursor-follow ambient glow, smoothed toward the pointer each tick.
      let cleanupGlow = () => {};
      if (!prefersReduced && glowRef.current) {
        const glow = glowRef.current;
        const pos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        const target = { x: pos.x, y: pos.y };
        const onPointerMove = (e: PointerEvent) => {
          target.x = e.clientX;
          target.y = e.clientY;
        };
        window.addEventListener("pointermove", onPointerMove);
        const glowTick = () => {
          pos.x += (target.x - pos.x) * 0.08;
          pos.y += (target.y - pos.y) * 0.08;
          glow.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
        };
        gsap.ticker.add(glowTick);
        cleanupGlow = () => {
          window.removeEventListener("pointermove", onPointerMove);
          gsap.ticker.remove(glowTick);
        };
      }

      // Hero intro: letter/line reveal, then badge/sub/actions/mockup fade up.
      if (!prefersReduced) {
        const tl = gsap.timeline({ delay: 0.15 });
        tl.to(".hero__title .ch", { y: 0, duration: 1.1, ease: "power4.out", stagger: 0.055 })
          .to(".line-mask .line", { y: 0, duration: 0.9, ease: "power3.out", stagger: 0.14 }, "-=0.55")
          .from(".nav, .hero__badge", { opacity: 0, duration: 0.8 }, "-=0.5")
          .from(
            ".hero__sub, .hero__actions, .mockup",
            { opacity: 0, y: 24, duration: 0.8, stagger: 0.1 },
            "-=0.5",
          );
      }

      // Scroll-triggered reveals for everything below the hero.
      if (!prefersReduced) {
        gsap.utils.toArray<HTMLElement>("[data-reveal]").forEach((el) => {
          gsap.fromTo(
            el,
            { opacity: 0, y: 56 },
            {
              opacity: 1,
              y: 0,
              duration: 1.05,
              ease: "power3.out",
              scrollTrigger: { trigger: el, start: "top 85%", toggleActions: "play none none none" },
            },
          );
        });
      }

      return () => {
        cleanupGlow();
        gsap.ticker.remove(lenisTick);
        lenis.destroy();
      };
    }, rootRef);

    return () => ctx.revert();
  }, []);

  const onWaitlistSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitted(true);
  };

  return (
    <div className="marketing" ref={rootRef}>
      <div className="cursor-glow" ref={glowRef} aria-hidden="true" />

      <nav className="nav">
        <div className="nav__logo">EDITABLE</div>
        <div className="nav__links">
          <a href="#how">How it works</a>
          <a href="#formats">Formats</a>
        </div>
        <div className="nav__actions">
          <Link className="nav__launch" href="/templates">Launch app</Link>
          <a className="nav__cta" href="#waitlist">Get early access</a>
        </div>
      </nav>

      {/* 01 · HERO */}
      <section className="hero" id="hero">
        <div className="hero__content">
          <p className="hero__badge">
            <span className="hero__dot" />
            Early access · rolling out format by format
          </p>
          <h1 className="hero__title" aria-label="EDITABLE">
            {"EDITABLE".split("").map((ch, i) => (
              <span className="ch" key={i}>{ch}</span>
            ))}
          </h1>
          <p className="hero__tag">
            <span className="line-mask"><span className="line">You bring the <span className="chip">content.</span></span></span>
            <span className="line-mask"><span className="line">We bring the <span className="chip">format.</span></span></span>
          </p>
          <p className="hero__sub">
            Proven viral video structures, turned into fill-in-the-blank templates.
            Film the clips we tell you to. Drop them in. That&apos;s the edit.
          </p>
          <div className="hero__actions">
            <a className="btn btn--primary" href="#waitlist">Get early access</a>
            <a className="btn btn--ghost" href="#how">See how it works ↓</a>
          </div>

          <div className="mockup" aria-hidden="true">
            <div className="mockup__frame">
              <div className="mockup__bar">
                <span className="mockup__dot" />
                <span className="mockup__dot" />
                <span className="mockup__dot" />
                <span className="mockup__barlabel">The Hot Take</span>
              </div>
              <div className="mockup__body">
                <div className="mockup__slot mockup__slot--done">
                  <span className="mockup__slotlabel">HOOK</span>
                  <span className="mockup__slotfile">hook_take_01.mp4</span>
                  <span className="mockup__check">✓</span>
                </div>
                <div className="mockup__slot mockup__slot--done">
                  <span className="mockup__slotlabel">TAKE</span>
                  <span className="mockup__slotfile">desk_cam.mp4</span>
                  <span className="mockup__check">✓</span>
                </div>
                <div className="mockup__slot mockup__slot--active">
                  <span className="mockup__slotlabel">PROOF</span>
                  <span className="mockup__slotfile">Drop clip here…</span>
                </div>
                <div className="mockup__slot">
                  <span className="mockup__slotlabel">CTA</span>
                  <span className="mockup__slotfile">Drop clip here…</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 02 · STORY */}
      <section className="story" id="story">
        <div className="story__inner">
          <h2 className="story__line" data-reveal>The edit takes hours.</h2>
          <h2 className="story__line" data-reveal>Cracking the format takes weeks.</h2>
          <h2 className="story__line story__line--accent" data-reveal>You&apos;d rather be creating.</h2>
          <p className="story__sub" data-reveal>
            Grinding in the timeline. Studying other creators, reverse-engineering why their videos work.
            None of that is the value you bring your audience. The videos that blow up follow structures
            that already worked a thousand times — you don&apos;t need to invent one. You need to fill one in.
          </p>
        </div>
      </section>

      {/* 03 · HOW IT WORKS */}
      <section className="how" id="how">
        <div className="how__inner">
          <p className="how__kicker" data-reveal>How it works</p>
          <h2 className="how__title" data-reveal>From blank timeline to posted, in four steps.</h2>
          <div className="how__grid">
            <div className="how__step" data-reveal>
              <span className="how__num">01</span>
              <h3>Pick a proven format</h3>
              <p>Structures pulled from videos that already went viral.</p>
            </div>
            <div className="how__step" data-reveal>
              <span className="how__num">02</span>
              <h3>Film the clips we tell you to</h3>
              <p>Each slot comes with a plain-English shot direction.</p>
            </div>
            <div className="how__step" data-reveal>
              <span className="how__num">03</span>
              <h3>Drop them in</h3>
              <p>Your clips snap into the labeled slots. That&apos;s the edit.</p>
            </div>
            <div className="how__step" data-reveal>
              <span className="how__num">04</span>
              <h3>Post</h3>
              <p>Cut, paced, and captioned. Out the door.</p>
            </div>
          </div>
        </div>
      </section>

      {/* 04 · FORMATS */}
      <section className="pitch" id="formats">
        <div className="pitch__inner">
          <p className="pitch__kicker" data-reveal>Formats</p>
          <h2 className="pitch__title" data-reveal>
            Proven structures,<br /><span className="accent">ready to fill in.</span>
          </h2>
          <p className="pitch__sub" data-reveal>
            Like practicing the problems that actually show up in the interview —
            except it&apos;s the video structures that actually show up on your feed.
          </p>
          <div className="pitch__formats">
            <div className="format" data-reveal>
              <span className="format__name">The Hot Take</span>
              <span className="format__slots"><i>HOOK</i><i>TAKE</i><i>PROOF</i><i>CTA</i></span>
            </div>
            <div className="format" data-reveal>
              <span className="format__name">The 3-Point Breakdown</span>
              <span className="format__slots"><i>HOOK</i><i>POINT 1</i><i>POINT 2</i><i>POINT 3</i><i>CTA</i></span>
            </div>
            <div className="format" data-reveal>
              <span className="format__name">The Myth Bust</span>
              <span className="format__slots"><i>MYTH</i><i>TRUTH</i><i>WHY</i><i>CTA</i></span>
            </div>
            <div className="format" data-reveal>
              <span className="format__name">The Before / After</span>
              <span className="format__slots"><i>BEFORE</i><i>TURN</i><i>AFTER</i><i>CTA</i></span>
            </div>
          </div>
        </div>
      </section>

      {/* 05 · WHO */}
      <section className="who" id="who">
        <div className="who__inner">
          <h2 className="who__line" data-reveal>
            For creators, experts, and small businesses
            who have something to say —
            <span className="accent"> but don&apos;t know how to make it land.</span>
          </h2>
        </div>
      </section>

      {/* 06 · CTA */}
      <section className="cta" id="waitlist">
        <div className="cta__inner">
          <h2 className="cta__title" data-reveal>Stop staring at the timeline.</h2>
          <p className="cta__sub" data-reveal>Early access is rolling out format by format.</p>
          <form className="cta__form" data-reveal onSubmit={onWaitlistSubmit}>
            <input type="email" placeholder="you@somewhere.com" required aria-label="Email" disabled={submitted} />
            <button type="submit">{submitted ? "You're in" : "Join the waitlist"}</button>
          </form>
          <p className={`cta__done${submitted ? " is-visible" : ""}`}>You&apos;re on the list. Talk soon.</p>
        </div>
        <footer className="footer">
          <span>EDITABLE</span>
          <span>You bring the content. We bring the format.</span>
          <span>© 2026</span>
        </footer>
      </section>
    </div>
  );
}

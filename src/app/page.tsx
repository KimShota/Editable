"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { copy } from "./landing-copy";
import { Bridge } from "./_landing/Bridge";
import { FiveSames } from "./_landing/FiveSames";
import { HeroWall } from "./_landing/HeroWall";
import { LeadForm } from "./_landing/LeadForm";
import { ProductPeek } from "./_landing/ProductPeek";
import "./marketing.css";

/** "It got me {200K} followers." → the braced part becomes an accent chip. */
const withChip = (line: string): React.ReactNode =>
  line.split(/(\{[^}]+\})/).map((part, i) =>
    part.startsWith("{") ? <span className="chip" key={i}>{part.slice(1, -1)}</span> : part,
  );

/**
 * Marketing landing page (plan/landing-page-founder-proof.md). The first half
 * is the founder's story in his own voice: the hero, the five things that
 * never changed, and the same reel on a brand-new account. From the pivot on,
 * Katalab takes over. One light palette throughout.
 */
export default function Home() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    gsap.registerPlugin(ScrollTrigger);

    const ctx = gsap.context(() => {
      let lenis: Lenis | null = null;
      let lenisTick: ((time: number) => void) | null = null;
      if (!prefersReduced) {
        lenis = new Lenis({ lerp: 0.09, smoothWheel: true, anchors: true });
        lenis.on("scroll", ScrollTrigger.update);
        lenisTick = (time: number) => lenis?.raf(time * 1000);
        gsap.ticker.add(lenisTick);
        gsap.ticker.lagSmoothing(0);
      }

      if (!prefersReduced) {
        // Hero intro: the two headline lines rise, then everything else fades up.
        gsap
          .timeline({ delay: 0.1 })
          .to(".hero__title .line", { y: 0, duration: 1, ease: "power3.out", stagger: 0.16 })
          .from(".nav", { opacity: 0, duration: 0.6 }, "-=0.6")
          .from(".hero__sub, .hero__stats, .hero .lead, .wallwrap", { opacity: 0, y: 24, duration: 0.8, stagger: 0.1 }, "-=0.5");

        gsap.utils.toArray<HTMLElement>("[data-reveal]").forEach((el) => {
          gsap.fromTo(
            el,
            { opacity: 0, y: 48 },
            {
              opacity: 1,
              y: 0,
              duration: 1,
              ease: "power3.out",
              scrollTrigger: { trigger: el, start: "top 88%", toggleActions: "play none none none" },
            },
          );
        });
      }

      // Videos and the pinned section change the page height after first paint.
      const refresh = () => ScrollTrigger.refresh();
      window.addEventListener("load", refresh);

      return () => {
        window.removeEventListener("load", refresh);
        if (lenisTick) gsap.ticker.remove(lenisTick);
        lenis?.destroy();
      };
    }, rootRef);

    return () => ctx.revert();
  }, []);

  return (
    <div className="marketing" ref={rootRef}>
      <nav className="nav">
        <div className="nav__logo">KATALAB</div>
        <div className="nav__actions">
          <Link className="nav__login" href="/login">{copy.nav.login}</Link>
          <a className="nav__launch" href="#get-started">{copy.nav.cta}</a>
        </div>
      </nav>

      {/* 01 · HERO (founder's voice) */}
      <section className="hero" id="hero">
        <div className="hero__content">
          <h1 className="hero__title">
            {copy.hero.lines.map((line) => (
              <span className="line-mask" key={line}>
                <span className="line">{withChip(line)}</span>
              </span>
            ))}
          </h1>
          <p className="hero__sub">{copy.hero.sub}</p>

          <ul className="hero__stats">
            {copy.hero.stats.map((stat, i) => (
              <li className="stat" key={stat.value}>
                <span className="stat__value">{stat.value}</span>
                <span className="stat__label">{stat.label}</span>
                <span className="stat__note">{stat.note}</span>
                {i === 0 && <span className="stat__arrow" aria-hidden="true">→</span>}
              </li>
            ))}
          </ul>

          <LeadForm id="get-started" />
          <HeroWall />
        </div>
      </section>

      {/* 02 · THE FIVE SAMES (pinned) */}
      <FiveSames />

      {/* 03 · SAME REEL, NEW ACCOUNT */}
      <Bridge />

      {/* 04 · PIVOT (Katalab's voice) */}
      <section className="pivot" id="pivot">
        <div className="pivot__inner">
          <p className="kicker" data-reveal>{copy.pivot.kicker}</p>
          <h2 className="pivot__title" data-reveal>{copy.pivot.title}</h2>
        </div>
      </section>

      {/* 05 · PRODUCT PEEK */}
      <ProductPeek />

      {/* 06 · THE FIVE SAMES, DONE FOR YOU */}
      <section className="done" id="done">
        <div className="done__inner">
          <h2 className="done__title" data-reveal>{copy.done.title}</h2>
          <ul className="done__rows">
            {copy.done.rows.map((row) => (
              <li className="done__row" key={row.same} data-reveal>
                <span className="done__same">{row.same}</span>
                <span className="done__arrow" aria-hidden="true">→</span>
                <span className="done__feature">
                  <strong>{row.feature}</strong>
                  <span>{row.note}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 07 · HOW IT WORKS */}
      <section className="how" id="how">
        <div className="how__inner">
          <h2 className="how__title" data-reveal>{copy.how.title}</h2>
          <div className="how__grid">
            {copy.how.steps.map((step, i) => (
              <div className="how__step" key={step.name} data-reveal>
                <span className="how__num">0{i + 1}</span>
                <h3>{step.name}</h3>
                <p>{step.line}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 08 · FINAL CTA */}
      <section className="cta" id="signup">
        <div className="cta__inner">
          <h2 className="cta__title" data-reveal>{copy.cta.title}</h2>
          <p className="cta__sub" data-reveal>{copy.cta.who}</p>
          <div data-reveal>
            <LeadForm />
          </div>
        </div>
        <footer className="footer">
          <span>KATALAB</span>
          <span>{copy.footer.tagline}</span>
          <span>{copy.footer.rights}</span>
        </footer>
      </section>
    </div>
  );
}

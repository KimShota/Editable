/* Editable — cinematic scroll site */

gsap.registerPlugin(ScrollTrigger);

const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------------- smooth scroll ---------------- */
const lenis = new Lenis({ lerp: 0.09, smoothWheel: true });
lenis.on("scroll", ScrollTrigger.update);
gsap.ticker.add((time) => lenis.raf(time * 1000));
gsap.ticker.lagSmoothing(0);

/* ---------------- ambient cursor glow ---------------- */
if (!prefersReduced) {
  const glow = document.getElementById("ambientGlow");
  const pos = { x: 0, y: 0 };
  const target = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  window.addEventListener("pointermove", (e) => {
    target.x = e.clientX;
    target.y = e.clientY;
  });
  gsap.ticker.add(() => {
    pos.x += (target.x - pos.x) * 0.08;
    pos.y += (target.y - pos.y) * 0.08;
    glow.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
  });
}

/* ---------------- hero intro ---------------- */
function startIntro() {
  if (prefersReduced) return;

  const tl = gsap.timeline({ delay: 0.15 });
  tl.to(".hero__title .ch", {
    y: 0,
    duration: 1.1,
    ease: "power4.out",
    stagger: 0.055,
  })
    .to(".line-mask .line", {
      y: 0,
      duration: 0.9,
      ease: "power3.out",
      stagger: 0.14,
    }, "-=0.55")
    .from(".nav, .hero__badge", { opacity: 0, duration: 0.8 }, "-=0.5")
    .from(".hero__sub, .hero__actions, .mockup", { opacity: 0, y: 24, duration: 0.8, stagger: 0.1 }, "-=0.5");
}
requestAnimationFrame(() => requestAnimationFrame(startIntro));

/* ---------------- text reveals ---------------- */
gsap.utils.toArray("[data-reveal]").forEach((el) => {
  if (prefersReduced) return;
  gsap.fromTo(
    el,
    { opacity: 0, y: 56 },
    {
      opacity: 1,
      y: 0,
      duration: 1.05,
      ease: "power3.out",
      scrollTrigger: { trigger: el, start: "top 85%", toggleActions: "play none none none" },
    }
  );
});

/* ---------------- waitlist ---------------- */
document.getElementById("waitlistForm").addEventListener("submit", (e) => {
  e.preventDefault();
  document.getElementById("ctaDone").classList.add("is-visible");
  e.target.querySelector("button").textContent = "You're in";
  e.target.querySelector("input").disabled = true;
});

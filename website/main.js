/* Editable — cinematic scroll site */

gsap.registerPlugin(ScrollTrigger);

const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------------- smooth scroll ---------------- */
const lenis = new Lenis({ lerp: 0.09, smoothWheel: true });
lenis.on("scroll", ScrollTrigger.update);
gsap.ticker.add((time) => lenis.raf(time * 1000));
gsap.ticker.lagSmoothing(0);

/* ---------------- frame sequence ---------------- */
const canvas = document.getElementById("seq");
const ctx = canvas.getContext("2d");

const seq = {
  manifest: null,
  images: [],
  loadedCount: 0,
  current: -1,
};

function sizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  // resizing resets context state, so smoothing must be re-applied here
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  drawFrame(seq.current >= 0 ? seq.current : 0, true);
}

function drawFrame(index, force) {
  if (!seq.manifest) return;
  // nearest loaded frame at or below the target, else the first loaded one
  let i = index;
  while (i > 0 && !(seq.images[i] && seq.images[i].loaded)) i--;
  if (!(seq.images[i] && seq.images[i].loaded)) {
    for (i = index; i < seq.images.length; i++) {
      if (seq.images[i] && seq.images[i].loaded) break;
    }
  }
  if (!(seq.images[i] && seq.images[i].loaded)) return;
  if (i === seq.current && !force) return;
  seq.current = i;

  const img = seq.images[i].el;
  const cw = canvas.width, ch = canvas.height;
  const s = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
  const w = img.naturalWidth * s, h = img.naturalHeight * s;
  ctx.clearRect(0, 0, cw, ch);
  ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
}

function frameSrc(i) {
  const m = seq.manifest;
  return m.path + m.prefix + String(i + 1).padStart(m.pad, "0") + "." + m.ext;
}

const loaderEl = document.getElementById("loader");
const loaderFill = document.getElementById("loaderFill");
let introStarted = false;

function updateLoader() {
  const total = seq.manifest ? seq.manifest.count : 1;
  loaderFill.style.width = Math.round((seq.loadedCount / total) * 100) + "%";
  // reveal the page once a healthy first chunk is in; keep loading behind the scenes
  if (!introStarted && seq.loadedCount >= Math.min(total, 40)) startIntro();
}

function loadFrames() {
  const m = seq.manifest;
  const queue = [...Array(m.count).keys()];
  const CONCURRENCY = 14;
  let inFlight = 0;

  function next() {
    while (inFlight < CONCURRENCY && queue.length) {
      const i = queue.shift();
      inFlight++;
      const el = new Image();
      seq.images[i] = { el, loaded: false };
      el.onload = () => {
        seq.images[i].loaded = true;
        seq.loadedCount++;
        inFlight--;
        if (i === 0) drawFrame(0, true);
        updateLoader();
        next();
      };
      el.onerror = () => {
        inFlight--;
        seq.loadedCount++;
        updateLoader();
        next();
      };
      el.src = frameSrc(i);
    }
  }
  next();
}

fetch("assets/frames/manifest.json")
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error("no manifest"))))
  .then((m) => {
    seq.manifest = m;
    sizeCanvas();
    loadFrames();
    buildScrub();
  })
  .catch(() => {
    // frames unavailable — fall back to the hero still so the page remains usable
    const img = new Image();
    img.onload = () => {
      seq.manifest = { count: 1, path: "", prefix: "", pad: 0, ext: "", phases: [] };
      seq.images = [{ el: img, loaded: true }];
      seq.loadedCount = 1;
      sizeCanvas();
      drawFrame(0, true);
      buildScrub();
      startIntro();
    };
    img.src = "assets/src/hero_reel.png";
  });

window.addEventListener("resize", sizeCanvas);

/* ---------------- scrub section ---------------- */
const captions = gsap.utils.toArray(".scrub__caption");
const scrubFill = document.getElementById("scrubFill");
let activeCaption = -1;

function setCaption(idx) {
  if (idx === activeCaption) return;
  captions.forEach((el, i) => {
    gsap.to(el, {
      opacity: i === idx ? 1 : 0,
      y: i === idx ? 0 : 24,
      duration: 0.55,
      ease: "power2.out",
      overwrite: true,
    });
  });
  activeCaption = idx;
}

function buildScrub() {
  const m = seq.manifest;
  const total = Math.max(m.count - 1, 1);

  // phase boundaries as scroll-progress fractions (default: thirds)
  let bounds = [1 / 3, 2 / 3];
  if (m.phases && m.phases.length === 3) {
    bounds = [m.phases[0].end / total, m.phases[1].end / total];
  }

  ScrollTrigger.create({
    trigger: ".scrub",
    start: "top top",
    end: "bottom bottom",
    scrub: prefersReduced ? false : 0.4,
    onUpdate(self) {
      const p = self.progress;
      drawFrame(Math.round(p * total));
      scrubFill.style.height = Math.round(p * 100) + "%";
      if (p < 0.015) setCaption(-1);
      else if (p < bounds[0]) setCaption(0);
      else if (p < bounds[1]) setCaption(1);
      else setCaption(2);
    },
    onLeave() { setCaption(-1); },
    onLeaveBack() { setCaption(-1); },
  });
}

/* ---------------- hero intro ---------------- */
function startIntro() {
  if (introStarted) return;
  introStarted = true;
  loaderEl.classList.add("is-done");

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
    .from(".nav, .hero__scrollhint", { opacity: 0, duration: 0.8 }, "-=0.4");
}

// safety: never leave the user stuck on the loader
setTimeout(startIntro, 9000);

/* ---------------- hero parallax ---------------- */
if (!prefersReduced) {
  gsap.to("#heroImg", {
    scale: 1.0,
    yPercent: 6,
    ease: "none",
    scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true },
  });
  gsap.to(".hero__content", {
    yPercent: -18,
    opacity: 0,
    ease: "none",
    scrollTrigger: { trigger: ".hero", start: "top top", end: "70% top", scrub: true },
  });
}

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

# Editable — Comprehensive Product Plan

*What it takes to go from "a great editor I built" to "the AI viral reel app I truly want."*

Last updated: 2026-07-24

---

## The one-paragraph thesis

The **editing engine is ~80% done and genuinely strong**; the **product is ~5% done**. The
6-stage pipeline, role-based (not keyword) timing, graceful LLM fallback, and a real
CapCut-grade NLE are the parts most people can't build — and they work. But the product the
landing page promises ("pick a proven format in your niche, fill it in, post") is bottlenecked
on things the engine doesn't touch: **the format library and the AI that builds and fills it.**
The engine is not the moat. The library is. And today it's a library of two.

---

## Where things actually stand

### What's built and good
- **Pipeline**: `intake → transcribe → (correct) → trim → roles → assemble → render`, each stage
  writing an inspectable JSON artifact.
- **Role-based timing**: events timed by plain-language descriptions the LLM locates in each
  user's transcript, with deterministic fallbacks. Adding a format is (in principle) data, not code.
- **Transcript correction** (just added): a lightweight LLM pass, biased by a per-job `lexicon`,
  that fixes Whisper's proper-noun/domain mishearings before they fan out into the title card,
  captured names, role matching, and burned-in captions.
- **NLE editor**: ripple trim, split, reorder, transitions (draggable), multi-select, undo/redo
  (50 steps), overlay canvas with spatial drag, per-word caption correction, keyboard shortcuts.
  `edl.json` becomes the source of truth once editing begins (like a project file).
- **Web app**: marketing landing page, templates gallery with niche filtering, job creation,
  slot-binding resource board with a drag-in media Library, build diagnostics surfaced to the user.
- **LLM providers**: `anthropic` (API) / `claude-cli` (local login) / `fallback`, auto-selected.

### What's missing (confirmed by inspection)
- **No format-authoring tooling.** Formats are hand-written ~1,600-line JSON. Only two exist.
- **AI is plumbing only.** It does role resolution + transcript correction. No creative help.
- **No publishing.** Render produces an MP4 in `out/`. No captions/hashtags/description, no
  scheduling, no direct post, no multi-aspect export (both formats are 9:16 only).
- **No app infrastructure.** No auth, no database, no billing, no cloud rendering, no queue.
  State is files on disk; rendering is a local `npx remotion render` child process on one machine;
  the waitlist form collects nothing (just flips a boolean).
- **No guided mobile capture.** The premise is "film on your phone"; the flow is desktop web.
- **The first cut still needs hand-fixing** — which is what kicked off this whole effort.

---

## The gaps, by leverage

### 1. The format library is the entire moat — and it's the scaling wall
Everything the product promises depends on "there's a proven format for *your* niche." There are
two formats (both now tagged `AI`), each a hand-authored JSON encoding anchors, semantic windows,
event sequences, and timing. There is no tooling to make one. This is the ceiling on the whole
product.

It splits into the two things the README says the product absorbs:

- **"Figuring out what works"** — reverse-engineering viral videos into formats. 100% manual today.
  This is the natural home for real AI: ingest a reference reel → transcribe → detect structure
  (hook / beats / CTA), overlay & SFX moments, pacing → emit a *draft* `format.json`. The same
  transcribe + LLM-resolver machinery, pointed at *analysis* instead of *assembly*.
- **A format-authoring UI** — a human reviews/tunes the AI draft. Hand-editing 1,600-line JSON with
  cross-referenced anchor ids is not a workflow.

> **This is the single highest-leverage thing to build.** It converts format creation from
> days-of-JSON into an editable draft — the only way the library grows past what one person can
> hand-write.

### 2. It's an "AI reel editor" that barely uses AI
Today AI = role resolution + transcript correction. Both plumbing. The creative leverage users
expect from "AI" is absent:

- **Script/hook generation** — "make a video about X" → draft the spoken lines per slot.
- **Asset sourcing** — suggest/fetch/generate B-roll, memes, reaction shots per beat (the
  five-secret-codes video leaned on hand-found memes).
- **Sound design** — auto-match SFX to detected moments instead of making the user upload and bind
  every effect by hand.
- **Feedback / virality scoring** — "your hook is weak; here's a stronger one." The retention loop.
- **Caption intelligence** — keyword emphasis, not just karaoke (current-spoken-word) highlighting.

### 3. The last mile — publishing — doesn't exist
"Cut, paced, captioned. Out the door." The door isn't built. After render: an MP4 on disk. Missing:
caption/hashtag/description generation, scheduling, direct publish to TikTok/Reels/Shorts,
thumbnails, A/B hook variants, and any aspect ratio besides 9:16.

- **Trending audio** is the #1 virality lever and the format punts on it entirely ("prefer adding
  trending audio inside Instagram/TikTok"). That may be a licensing necessity — but it should be a
  deliberate, designed decision, not a silent gap.

### 4. There is no "app," infrastructurally
A superb single-user local tool. To be the app you want: accounts + multi-tenant storage, a real DB,
cloud rendering (e.g. Remotion Lambda) behind a job queue, and payments. None of it is hard relative
to what's already built; none of it is started. Do it *before a launch*, not before validating the
first 1–2 users.

### 5. The capture gap (sneaky-important)
The moment of value ("just film what the template tells you") happens on a phone; the app is desktop
web. No guided in-app camera showing the shot direction per slot, no clean phone→project handoff.
Closing this is what makes the promise feel real instead of "shoot on your phone, AirDrop to a
laptop, drag files into dropzones."

### 6. The auto-cut still isn't good enough to skip editing
This whole effort started because the pipeline's output got *manually re-edited*. That's the tell.
Every manual fix a user still has to make is a crack in "you don't need any of that." Close the gap
between auto-cut and hand-delivered systematically — and measure it by diffing pipeline output vs.
final edit every time (exactly what we did with the caption fix).

---

## Recommended sequence

1. **Format-authoring pipeline** (reverse-engineer a reel → draft `format.json`) **+ a review UI.**
   Unlocks the library, which unlocks everything. Highest leverage by far.
2. **Real AI creative help** — start with hook/script generation and asset suggestion; that's what
   users *feel* as "AI."
3. **Publishing last-mile** — captions/description/hashtags + multi-aspect export, then
   scheduling / direct-post.
4. **Productionize** — accounts, storage, cloud render, billing — ahead of a real launch.
5. **Guided mobile capture** — the missing half of "just film what we tell you."

**Strong opinion:** #1 is the thing. The editor being this good is almost a trap — it's tempting to
keep polishing it, but the product is stuck at two formats and no editor polish moves that. The
reverse-engineering pipeline is both the hardest bet and the only one that turns this from "a great
editor I built" into "the app I truly want."

---

## Appendix — verification notes

These claims were checked against the code (2026-07-24), not assumed:

- **No auth/db/billing/cloud-render deps** in `package.json`.
- **Render** = `spawn`'d `npx remotion render` child process with a polled `render-status.json`
  (`src/app/api/jobs/[jobId]/render/route.ts`, `src/backend/pipeline/render.ts`) — single machine.
- **State** lives in `jobs/`, `artifacts/`, and `public/` on disk — no database.
- **Waitlist** `onWaitlistSubmit` only calls `setSubmitted(true)` (`src/app/page.tsx`).
- **Formats**: two files, both `1080×1920` (9:16), both now `"niche": "AI"`.
- **AI usage**: `resolvers/` (role resolution) + `correctTranscript.ts` (new) — nothing creative.
- **Editor**: `edl.json` is the source of truth in-editor; ops in
  `src/backend/pipeline/timelineOps.ts`. Known limitation noted there: overlays/sfx/captions are
  not auto-retimed when a video-track ripple shifts things beneath them.

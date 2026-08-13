# Editable

**Editable turns proven viral video formats into fill-in-the-blank
templates.** Each template is a real format that already works, broken
into labeled lego blocks. You pick one for your niche, film the clips it
asks for, and it assembles a ready-to-post video — no editing skill, and
no guessing at what makes a video go viral, required.

The two hardest, most time-consuming parts of being a creator are (1)
figuring out *what's working* — studying other creators and
reverse-engineering their formats — and (2) the editing itself. This
product absorbs both. You're left with the one part that's actually
yours: the content — your expertise, your story.

How it works:

1. **Pick a template** in your niche.
2. **Film a clip for each labeled block.** The template tells you exactly
   what to shoot for each one, based on what's proven to perform.
3. **Plug the clips in** and get an assembled video out.

The work is structural *assembly*, not animation — most formats don't
need fancy effects to land. Maybe a little motion in the hook, nothing
more. The lever isn't out-editing anyone; it's knowing the right
structure. The promise to someone with real expertise but zero editing
knowledge is simply: *you don't need any of that — just show up and film
what the template tells you to.*

Beyond the structure, a template also gives you per-block filming
guidance (what to shoot, shot by shot) and suggestions for which
sound/audio fits each moment (you supply the actual file). If you want
to take it further after assembly, you still can.

## The pipeline

The engine is a chain of modules joined by fixed contracts — each stage
writes an inspectable JSON artifact:

```
format + user assets
  → intake      (bind assets to named slots, validate —
                 including a talking-head framing pre-check
                 for backgroundReplace formats)          artifacts/<job>/filled.json
  → generate    (fill AI-generated slots — inserts, model shots)   artifacts/<job>/inserts.json
  → transcribe  (whisper.cpp word timestamps; single-take
                 formats use split instead — one whisper pass
                 over the shared take, sliced per block)   artifacts/<job>/transcript.json
  → trim        (cut dead air; trim first, then time;
                 alignToScript + optional LLM lexicon pass
                 correct the transcript against script.json —
                 writes PURE, take-relative spans)         artifacts/<job>/trim.json
  → matte       (single-take formats only: mattes each
                 backgroundReplace block — RVM if available,
                 else Vision + temporal median — as its own
                 isolated, inspectable stage; persists masks
                 + an alpha-over-checkerboard preview)      artifacts/<job>/matte.json
  → composite   (single-take formats only: composites flagged
                 blocks onto the format's own checked-in
                 plates — formats/assets/<id>/ — consuming
                 matte's masks, never re-matting)           rewrites transcript.json/trim.json
  → roles       (LLM finds format-defined moments)       artifacts/<job>/roles.json
  → assemble    (master timeline: the EDL)               artifacts/<job>/edl.json
  → render      (Remotion → MP4, then acceptance gates
                 run against the actual export)           out/<job>.mp4, artifacts/<job>/gates.json
```

When a video comes out wrong, don't stare at the video — look at which
artifact first went wrong. A failed acceptance gate (`gates.json`) fails
the build — see `src/backend/pipeline/gates.ts`.

### One-time setup

```bash
npm install
brew install ffmpeg whisper-cpp
curl -L -o models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin

# RVM (video-native matting for backgroundReplace formats) — optional:
# falls back to Apple Vision + temporal median if the model file is
# missing, so this step can be skipped, at a real cost to hair-edge
# stability (see src/backend/pipeline/generation/rvm.ts).
curl -L -o models/rvm_mobilenetv3_fp32.onnx \
  https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx
```

### Run it

```bash
npm run pipeline -- --job jobs/demo
```

To inspect a matte on its own before running the full pipeline (useful
when tuning a new format's own plates/framing target):

```bash
npm run matte:proof -- --video <take.mov> [--in <sec>] [--out <sec>] \
  [--engine rvm|vision|both] [--downsample <ratio>]
```

Flags:

- `--only <stage>` — re-run a single stage against the artifacts on disk
  (`intake | generate | transcribe | trim | matte | composite | roles |
  assemble | render`).
  Note: `--only assemble`/`--only roles`/etc. read `filled.json` (pure
  intake output) from disk rather than re-deriving it, so a single-take
  format's backgroundReplace-composited clips only carry through within
  ONE full (no `--only`) invocation — re-run the whole pipeline, not a
  later stage alone, after changing anything upstream of `trim`. Likewise,
  `--only composite` reads `trim.json` as pure/take-relative and rebases
  it in place — running `--only composite` a SECOND time without an
  intervening `--only trim` re-rebases an already-rebased `trim.json`;
  always re-run from `--only trim` forward rather than repeating
  `--only composite` alone.
- `--generator <name>` — insert/model-shot generation provider:
  `model-shots` (default in `auto`) — deterministic photo-on-plate
  composites plus Gemini for shots no photo can cover, `gemini`,
  `higgsfield`, or `fallback` (Ken-Burns over a raw identity photo, no
  compositing)
- `--resolver <name>` — role-resolution provider:
  - `anthropic` — Anthropic API (`ANTHROPIC_API_KEY` in `.env`)
  - `claude-cli` — your local `claude` login, no key needed
  - `fallback` — no LLM; every role uses its config fallback position
  - `auto` (default) — API key → claude CLI → fallback

### A job

A job is a directory with the user's content: a `job.json` manifest
binding each of the format's named slots to a file (`{"file": "assets/…"}`)
or a text string (`{"text": "…"}`), plus the assets. See `jobs/demo/`.
Per-video tweaks go in an optional `"overrides"` key (nudge an event's
time, swap a transition) — they never touch the shared format.

### A format

A format is a proven structure encoded as data: `formats/<id>.json`.
Blocks, named slots with filming instructions, overlay/sfx events, and —
the important part — **roles, not keywords**: events are timed by a
plain-language description of the moment they belong to ("the pivot from
problem to solution"), which the LLM locates in each user's own
transcript, with a deterministic fallback position when it can't. Adding
a format means writing a new config file, never touching the engine.

### Layout

The backend (engine) and frontend (web app) are separate folders under
`src/`, with a one-way dependency: the app imports from the engine via the
`@backend/*` path alias, never the other way around.

- `src/backend/pipeline/` — the six modules + `schemas.ts`/`types.ts` (the contracts)
- `src/backend/pipeline/resolvers/` — pluggable LLM providers for role resolution
- `src/backend/remotion/EdlVideo.tsx` — generic EDL renderer (one renderer, many formats)
- `src/backend/index.ts` — the Remotion entry point (`remotion studio`/`bundle`/`render` all target this explicitly, since it's no longer at the default `src/index.ts` location)
- `formats/` — the format library
- `jobs/` — job directories (user content)
- `src/backend/templates/csResources.ts` + `src/backend/TemplateVideo.tsx` —
  the legacy hand-timed template, kept for reference (`CsResources` composition)
- `src/app/` — the Next.js web app (pages, API routes, UI)

`npm run dev` opens Remotion Studio; the `EdlVideo` composition previews a
placeholder EDL (real renders pass a job's EDL via `--props`).

### Running the web app

```bash
npm run app:dev      # http://localhost:3100
npm run app:build    # what deploy/update.sh runs on the server
npm run app:start
```

`app:dev` pins `--max-old-space-size=4096` deliberately. Turbopack's dev
server opens an HMR subscription per server chunk
(`next/dist/server/dev/hot-reloader-turbopack.js`, `subscribeToServerHmr`)
and pumps each one through an async iterator that buffers events in an
unbounded array. On Next 16.2.10 that could run away: a dev server left
open while files changed underneath it climbed past 8GB of JS heap and
died with `FATAL ERROR: Ineffective mark-compacts near heap limit`, after
first pushing the machine into swap hard enough to make everything else
unusable — the thrashing was worse than the crash. Next 16.3 fixes the
underlying cause (memory eviction for the dev cache, on by default, plus
collapsing those per-chunk subscriptions into one), so the cap is a
backstop, not the fix: it turns any recurrence into a fast crash you can
restart instead of a wedged laptop. Node otherwise defaults the limit to
roughly half of physical RAM (8.4GB on a 16GB machine), which is far more
than this app legitimately needs — a healthy session sits near 120MB.

Only `next dev` is affected. `next start` never loads the dev
hot-reloader, so the deployed box is not exposed to this.

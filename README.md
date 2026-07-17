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
  → intake      (bind assets to named slots, validate)   artifacts/<job>/filled.json
  → transcribe  (whisper.cpp word timestamps)            artifacts/<job>/transcript.json
  → trim        (cut dead air; trim first, then time)    artifacts/<job>/trim.json
  → roles       (LLM finds format-defined moments)       artifacts/<job>/roles.json
  → assemble    (master timeline: the EDL)               artifacts/<job>/edl.json
  → render      (Remotion → MP4)                         out/<job>.mp4
```

When a video comes out wrong, don't stare at the video — look at which
artifact first went wrong.

### One-time setup

```bash
npm install
brew install ffmpeg whisper-cpp
curl -L -o models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

### Run it

```bash
npm run pipeline -- --job jobs/demo
```

Flags:

- `--only <stage>` — re-run a single stage against the artifacts on disk
  (`intake | transcribe | trim | roles | assemble | render`)
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

- `src/pipeline/` — the six modules + `schemas.ts`/`types.ts` (the contracts)
- `src/pipeline/resolvers/` — pluggable LLM providers for role resolution
- `src/remotion/EdlVideo.tsx` — generic EDL renderer (one renderer, many formats)
- `formats/` — the format library
- `jobs/` — job directories (user content)
- `src/templates/csResources.ts` + `src/TemplateVideo.tsx` — the legacy
  hand-timed template, kept for reference (`CsResources` composition)

`npm run dev` opens Remotion Studio; the `EdlVideo` composition previews a
placeholder EDL (real renders pass a job's EDL via `--props`).

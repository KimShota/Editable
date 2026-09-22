---
name: reel-to-template
description: Use when the user pastes an Instagram Reel (or TikTok/YouTube Shorts) link and wants it turned into a reusable Katalab format/template — reverse-engineer this reel, turn this reel into a template, clone this edit's style, make this into a format so other people can fill in their own footage. Also use for "analyze this viral video's structure" or "why does this reel work" when the end goal is a fill-in-the-blank template, not just a written breakdown. Drives this repo's own authoring pipeline (`npm run author`) end to end: ingest → analyze → author draft.json → validate → verify → save. For editing a user's raw footage INTO an existing format, use reel-edit instead.
metadata:
  version: 1.0.0
---

# Reel → Template

Turns one reference reel into a saved `formats/<id>.json` that the render
pipeline (and `reel-edit`) can fill with anyone's own footage. Wraps this
repo's own `npm run author` CLI (`src/backend/authoring/`) — don't
reinvent ingest/transcription/scene-detection/verification, they already
exist and are tested against real drafts.

**Method credit:** the analysis approach (contact sheets, internal-build
counting, condition-based style rules, originality guardrail) is adapted
from the open-source `reel-style-clone` skill in
`krusemediallc/video-editor-agent` (MIT-adjacent, publicly documented),
combined with this repo's own `FormatSchema`.

## Why you author `draft.json` yourself, not via `--only synthesize`

`--only synthesize` calls the Anthropic API directly and needs
`ANTHROPIC_API_KEY` credits — that's the web app's path, and it's known
to run out of budget mid-project. You (the agent running this skill) ARE
already a multimodal model with the reel's frames in context, so write
`authoring/<draftId>/draft.json` yourself with the Write tool, following
`references/format-schema.md` (which just points at the single real
source of truth, `src/backend/authoring/formatContract.md` — read that
file, don't skim a summary of it). This costs nothing beyond
the conversation you're already having, and produces the exact same
artifact shape `--only verify`/`author:save` expect.

## Workflow

### 1. Ingest

```
npm run author -- --url <reelLink> --only ingest
```
Prints the new draft id (`draft-xxxxxxxx`) — remember it, everything
below needs `--draft <id>`. If this fails, read
`references/troubleshooting.md` (Instagram login walls, silent reels)
before giving up or asking the user to intervene themselves — the fixes
are usually one env var or a `--file <path>` fallback.

### 2. Analyze

```
npm run author -- --draft <id> --only analyze
```
Writes `authoring/<id>/analysis.json` (word-level transcript, shot
boundaries, sampled frames) and `authoring/<id>/frames/*.jpg`. Then run:
```
.claude/skills/reel-to-template/scripts/contact-sheets.sh <id>
```
which tiles frames into review-friendly grids and adds a waveform +
spectrogram to `authoring/<id>/evidence/`.

### 3. Study the reel

Read `analysis.json`, the contact sheets, and the individual frames
(read the actual per-frame JPGs in `frames/` for precise layout
measurement — the tiled contact sheets are for fast overview only, they're
too small to measure a box from accurately). Work through
`references/analysis-checklist.md`'s seven sections and write your
findings to `authoring/<id>/style-notes.md`. Apply its originality rule:
every string you write must be your own structural description, never
the creator's actual words.

Before picking an `id`/`niche`, check what already exists:
```
ls formats/*.json
grep -h '"niche"' formats/*.json
```
Reuse an existing niche if it genuinely fits; only mint a new one-word
niche otherwise.

### 4. Write `draft.json`

Read `src/backend/authoring/formatContract.md` in full (the
schema contract — field-by-field, with the closed component list and
what's out of scope for this stage). Write
`authoring/<id>/draft.json` matching `DraftSchema`:
```json
{
  "draftId": "<id>",
  "sourceUrl": "<the exact sourceUrl from authoring/<id>/ingest.json>",
  "createdAt": "<ISO timestamp, now>",
  "rationale": "2-4 sentences: the structural pattern you found",
  "format": { ... per formatContract.md ... }
}
```

### 5. Validate — loop until clean

```
npm run author -- --draft <id> --only validate
```
Cheap and render-free; loop fix→validate freely.
`references/troubleshooting.md` covers the common cross-reference errors.

### 6. Verify — render and score against the reference

```
npm run author -- --draft <id> --only verify
```
Renders the draft against its OWN reference clip and scores each block
by SSIM (`authoring/<id>/verify.json`; `overallScore` is the MINIMUM
block score, deliberately, so one bad block can't hide behind good ones).
For anything below ~0.85, compare `authoring/<id>/verify/crops/` against
`frames/` at the same timestamps and fix the specific field responsible
(see `references/troubleshooting.md`). Re-run `--only verify` after each
fix. **Stop after 3 rounds** and report the honest per-block breakdown
rather than continuing to guess.

Optionally, stress-test how the anchors hold up against differently
worded recordings:
```
npm run test:anchors -- --format <id>
```
(this needs `authoring/<id>/draft.json` to already be there — it runs
made-up transcripts through the real anchor-matching code, no filming or
rendering involved).

### 7. Confirm with the user, then save

Show the user: the block list with each slot's filming instructions, the
per-block verify scores, and anything you couldn't get above target.
**Wait for their go-ahead before saving** — this writes into the shared
`formats/` library other people's jobs will read from.
```
npm run author:save -- --draft <id>
```
Writes `formats/<id>.json` and registers the reel in
`formats/meta/reels.json`. A 409 means the id is taken — see
`references/troubleshooting.md`.

## References

- `references/format-schema.md` — points to the real schema contract.
- `references/analysis-checklist.md` — the 7-section study method.
- `references/troubleshooting.md` — ingest/validate/verify/save failure modes.

---
name: reel-edit
description: Use when the user has a Katalab format/template (from reel-to-template, or an existing formats/*.json) and wants their own raw footage edited into that same style — edit my footage into this template, fill in this format with my clips, auto-edit these clips like the reference reel. Drives this repo's own render pipeline (`npm run pipeline`) end to end: match footage to slots → write job.json → render → self-check the actual output → deliver. For turning a reference reel INTO a template in the first place, use reel-to-template instead.
metadata:
  version: 1.0.0
---

# Reel Edit

Takes an existing `formats/<id>.json` plus a user's raw footage and
produces a finished MP4 in the same style. Wraps this repo's own
`npm run pipeline` CLI (`src/backend/pipeline/`) — the engine already
does transcription, trimming, role timing, and rendering; this skill's
job is matching footage to the right slots and catching problems in the
actual rendered output before handing it over.

**Method credit:** the self-check approach (read the transcript/EDL
first, sample the RENDERED output only at decision points, check every
cut boundary before showing the user) is adapted from the open-source
`video-use` project (browser-use/video-use, MIT).

## Workflow

### 1. Pick the format

If the user named one, read `formats/<id>.json` directly. Otherwise:
```
ls formats/*.json
```
and read each candidate's `name`/`niche`/`description` to help the user
choose, rather than picking for them.

### 2. Match footage to slots

Read `references/binding-guide.md` first — it covers `speakingTakeSlot`
(bind the whole take, don't split it yourself), text/`control` slots,
and multi-take bindings. Probe and thumbnail each candidate file, match
against each slot's `instructions`, and ask the user rather than
guessing on a genuinely ambiguous match.

### 3. Confirm, then write the job

Show the user the planned slot → file mapping (and any text you're
about to bind) before writing anything. Once confirmed:
```
mkdir -p jobs/<name>/assets
cp <footage> jobs/<name>/assets/
```
then write `jobs/<name>/job.json` per `references/binding-guide.md`.

### 4. Render

```
npm run pipeline -- --job jobs/<name>
```
Produces `out/<name>.mp4` and `artifacts/<name>/gates.json`. Read
`gates.json` — don't treat a 0 exit code alone as "it's good."

### 5. Self-check the actual rendered output

Read `artifacts/<name>/edl.json`'s `video[]` array for the real cut
boundaries (`tlInSec`/`tlOutSec` on the final timeline). For each cut,
plus the first 2s, the last 2s, and 2-3 mid-points, run:
```
.claude/skills/reel-edit/scripts/timeline-view.sh out/<name>.mp4 <start> <end>
```
and look at the filmstrip + waveform for: a visual jump/flash at the
cut, an audio pop, a caption hidden behind an overlay, or an overlay
sitting in the wrong place. Fix what you find with the smallest tool
that can fix it — `--only roles`, `--only assemble`, or `--only render`
against the same job, or a `job.json` `overrides` entry for a specific
event/transition (see `references/binding-guide.md`) — then re-render
and re-check. **Stop after 3 rounds** and report remaining issues
honestly instead of continuing to guess.

### 6. Deliver

Hand over the `out/<name>.mp4` path, the gate results, and anything you
know is still imperfect. Don't claim it's flawless if the self-check
surfaced something you couldn't fully resolve.

## References

- `references/binding-guide.md` — format/slot reading, job.json shape,
  matching footage, gates.json.

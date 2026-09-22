# Troubleshooting

## Ingest

**`yt-dlp failed to download ... login|rate.limit|not available`**
Instagram is gating anonymous access. Two options, in order of
preference:
1. Ask the user to set `EDITABLE_YTDLP_COOKIES_BROWSER` in `.env` to a
   browser they're logged into Instagram in (`chrome`, `firefox`,
   `safari`, or `edge`), then retry `--only ingest`. This reads that
   browser's own cookie database locally via yt-dlp's own
   `--cookies-from-browser` — nothing is sent anywhere except to
   Instagram itself, same as the user browsing normally.
2. If that's not available or still fails, ask the user to download the
   reel themselves (save-video / screen-record) and pass it with
   `--file <path>` instead of `--url`.

**"has no audio track"**
The pipeline can't build a format from a fully silent reel (nothing to
transcribe/anchor against). Confirm with the user this is really the
right reference — a music-only reel needs to be authored almost entirely
out of `broll` blocks by hand, which this skill doesn't automate.

## Analyze

**Whisper/ffmpeg errors, or a `models/ggml-medium.bin` missing error**
This is a one-time setup gap, not a per-draft problem — see the
project's own root `README.md` "One-time setup" section
(`brew install ffmpeg whisper-cpp` + downloading the model file). Tell
the user rather than trying to work around it.

## Validate (`--only validate`)

Read the zod error list literally — every message names the exact field
and, for cross-reference errors (`unknown anchor "..."`,
`duplicate ... id`), the exact id involved. Common causes:
- An event's `timing.roleId` (or a `states[].trigger.roleId`, or a
  semantic anchor's `window.afterAnchor`/`beforeAnchor`) misspells or
  references an anchor id from a DIFFERENT block — anchor ids only
  resolve within their own block.
- Two events reused the same `id` across different blocks — event ids
  must be unique across the WHOLE format, not just within a block.
- A `capture: true` literal anchor's `phrases` include part of the
  variable content itself (see formatContract.md's own warning on this —
  it's the single most common authoring mistake and it fails silently at
  RUNTIME, not at validate time, so get this right up front).

Loop `--only validate` — fix — `--only validate` until clean. It's
render-free and near-instant, so iterate here freely before moving to
verify.

## Verify (`--only verify`)

- **A block is `"skipped"` instead of scored**: usually means no
  matching anchor was found when verify tried to locate that block's own
  span inside the reference clip. Check the block's literal anchor
  `phrases` against what's actually said in the transcript
  (`authoring/<draftId>/analysis.json`) — they need to match closely
  enough for the SAME anchor-matching logic real jobs use.
- **Low SSIM on a specific block**: `authoring/<draftId>/verify/crops/`
  is ONLY populated for `ImageOverlay` events (verify.ts crops the
  reference's own pixels at that image's reveal moment) — for any other
  component it stays empty, that's not a bug. Instead, extract a few
  frames from `out/verify-<draftId>.mp4` at that block's own timestamps
  (`ffmpeg -ss <t> -i out/verify-<draftId>.mp4 -frames:v 1 <out>.jpg`,
  or the `timeline-view.sh` script from the reel-edit skill) and compare
  against `authoring/<draftId>/frames/` at the same timestamps. Usually
  one of: a `layout` box measured slightly off, a caption variant/theme
  mismatch, a `transitionAfter` the reference doesn't actually have (or
  is missing), or — the more common one — the beat boundaries you drew
  don't match where the reference ACTUALLY cuts to a different shot
  (e.g. it cuts to a screen-recording mid-sentence in a beat you modeled
  as pure talking-head); re-check the shot list in `analysis.json`
  against your block's own assumed span before changing anything else.
  Fix the specific field, don't re-author the whole block.
- **A block's own text/image overlay looks doubled or garbled in the
  self-verify render**: expected when the REFERENCE clip already has its
  own on-screen text baked into the same area your new overlay renders
  into — self-verify renders your authored overlay on top of the
  reference's real (already-captioned) pixels, so the two visibly
  overlap. This is an artifact of self-verify only; a real user's raw
  footage won't already have that text burned in. Don't chase this one.
- **A block with NO anchors at all** (e.g. a plain bridging beat) can
  destabilize the PREVIOUS block's own event timing during self-verify —
  block splitting locates each block's end by finding the NEXT block's
  own marker phrase, and a block with an empty `anchors: []` gives it
  nothing to find. Give every voice block at least one low-stakes
  literal anchor (`capture: false` is fine) purely for boundary
  stability, even if nothing else in that block needs one.
- **Low SSIM on a `motion`-authored event's own enter/exit window**
  (`verify.json`'s `windows[]`, not `blocks[]`): the animation itself is
  off — check keyframe `at` fractions and values against consecutive
  frames again; a common mistake is guessing a duration instead of
  measuring it off the actual frame timestamps.
- **`overallScore` stuck below target after 3 repair rounds**: stop
  iterating and report the per-block breakdown to the user honestly
  rather than continuing to guess — some references have a genuinely
  hard-to-verify moment (e.g. a very fast whip-pan) where the automated
  score will never be high even though the format is fine. Say so.

## Save (`npm run author:save`)

- **409 "already exists"**: change `format.id` in `draft.json` (and
  re-run `--only validate`) — ids aren't reused.
- The save also registers the reel in `formats/meta/reels.json` when
  `draft.json`'s own `sourceUrl` is a real link — skip worrying about
  this, it's automatic and safe to ignore for a `--file` ingest (which
  has no real URL to record).

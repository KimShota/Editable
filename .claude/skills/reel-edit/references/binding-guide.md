# Binding guide

## Reading a format

A format's blocks/slots are all in `formats/<id>.json` — read it
directly rather than guessing. For each block:
- `kind: "voice"` — the user needs to be talking on camera, saying
  something matching the block's literal anchor phrasing.
- `kind: "broll"` — silent footage/screen-recording, no speech needed.
- `slots[]` — everything that block needs. `slot.instructions` is the
  filming/sourcing guidance that was written for a human; use it to
  judge whether a candidate file actually fits.
- `slot.required` — an unfilled required slot fails intake before
  anything renders; an unfilled optional one is just skipped.

If the format declares a top-level `speakingTakeSlot`, the user films
(or already has) ONE continuous take covering every voice block's lines
back to back — bind the WHOLE raw take to that one slot's name. Do NOT
try to split it into per-block clips yourself; a dedicated pipeline
stage locates each block's own span inside it via anchor matching. Every
per-block `videoSlot` is then derived automatically — don't also try to
bind those individually.

## Matching raw footage to slots

For each candidate file: probe it (`ffprobe`), and for video/image
grab a quick thumbnail (`ffmpeg -ss <mid> -i <file> -frames:v 1
<thumb>.jpg`) to actually look at rather than guessing from the
filename alone. Compare against each unfilled slot's `mediaType` and
`instructions`. When a match is genuinely ambiguous (two clips could
both be block 2's hook, say), ask the user rather than picking — a wrong
bind only shows up much later, after a full render.

Text slots (`mediaType: "text"`) need a literal string from the user —
ask for it if not given. A slot with `control` (`choice`/
`orderedChoice`) wants one of its `options[].value` (or, for
`orderedChoice`, several joined with `", "` in the chosen order) — don't
invent a value outside that set.

## Writing `job.json`

```
jobs/<name>/
  job.json
  assets/<files>
```
```json
{
  "format": "<formatId>",
  "bindings": {
    "<slotName>": { "file": "assets/<file>" },
    "<textSlotName>": { "text": "..." },
    "<multiTakeVoiceSlot>": { "files": ["assets/take1.mp4", "assets/take2.mp4"] }
  },
  "lexicon": ["ProperNoun", "BrandName"],
  "language": "auto"
}
```
- Paths in `bindings` are relative to the job dir (copy footage into
  `assets/` first, then reference it as `"assets/<file>"`).
- `{ "files": [...] }` (plural) is only valid for a voice block's own
  main clip slot — multiple takes of the same line, engine picks the
  best one. Every other slot takes a single `{ "file": ... }` or
  `{ "text": ... }`.
- `lexicon`: proper nouns/brand names/coined terms this specific job's
  content uses that Whisper wouldn't expect — ask the user if the
  content has any, it measurably improves transcript accuracy and
  therefore caption/anchor quality.
- `language`: leave `"auto"` unless the user says otherwise.
- Don't hand-author `overrides` up front — only add it during the
  self-check repair loop, keyed by the specific event/block id that
  needs a nudge (see SKILL.md step 5).

## Running without an API key

Role resolution (matching semantic anchors to the real transcript)
tries, in order: `ANTHROPIC_API_KEY` → the local `claude` CLI login
(`--resolver claude-cli`) → a fixed fallback position. So the pipeline
runs even with no key configured — if role timing looks off and no key
is set, that's expected (fixed-fallback quality), not a bug; mention it
to the user rather than treating it as a failure to debug.

## Reading `gates.json`

`artifacts/<job>/gates.json` (written after render) is a list of
automated acceptance checks — read it, don't just trust that render
exiting 0 means the video is good. Report any failed/skipped gate to the
user by name rather than only saying "render succeeded."

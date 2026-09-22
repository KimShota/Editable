# Analysis checklist

Work through these seven sections before writing `draft.json`. Write your
findings to `authoring/<draftId>/style-notes.md` as you go — it's cheap
insurance: if synthesis needs a second pass, or a reviewer asks "why did
you time it that way," the reasoning is on disk instead of lost with your
context. This method is adapted from a published `reel-style-clone` skill
(krusemediallc/video-editor-agent) — see the main SKILL.md for the source.

For each section below, the goal isn't just "what does it look like" —
it's "what's the *rule* the reference is following," since that rule is
what has to survive into the format so it applies to a completely
different creator's completely different footage.

## 1. Pacing

- Count hard cuts (shot boundaries in `analysis.json`) and divide by
  duration → cuts/second, overall and per-section (hook vs. body vs. CTA
  usually differ — hooks cut faster).
- Also count **internal builds**: caption pops, zooms, overlay pop-ins
  *within* a single shot. A clone that matches the hard-cut rate but
  misses internal builds will feel roughly half as fast as the reference —
  this is the single easiest thing to under-count.
- Note shot-length ranges by section.
- Is there a once-per-video signature move (a whip-pan, a flash frame, a
  speed ramp)? Note it, and use it exactly once in the format — repeating
  it downgrades a signature to a gimmick.

## 2. Captions

Don't describe one constant look — describe the **condition** that
triggers each look. E.g. "sans-serif lowercase while the face is
on-screen; serif ALL-CAPS when a graphic replaces it." Note:
- Font weight/case, size, position anchor, color(s).
- Timing: on-beat with speech, delayed, staggered word-by-word, or
  synced to a specific word.
- Whether a big keyword card punches through the ordinary caption line
  (→ `captionVariant: "bigTitle"` + `keywordTitle`), or fully replaces it
  (→ `"karaokeTitle"`). Most reels are plain `"lowerThird"` — don't reach
  for the other two unless the reference clearly does something else.

## 3. Graphic language

Name every recurring visual device and state its **function**, not just
its look — e.g. "screenshot-over-blur: establishes the claim as evidence"
or "blue highlight sweep: controls where the eye goes next." For each:
opacity, duration, what triggers it (a word, a cut, a fixed offset), and
where exactly it sits on screen (measure the box as a fraction of frame
width/height from a frame where it's fully visible — this becomes the
event's `layout`).

## 4. B-roll grammar

- Framing modes used (close-up, wide, overhead, screen-recording).
- Aspect-ratio handling if source footage doesn't natively match 9:16
  (crop vs. blur-pad).
- Transition style into/out of b-roll (cut, fade, zoom).
- Zoom velocity/style if the b-roll itself moves.

## 5. Color & grade

- Dominant hues, saturation level, contrast curve (crushed blacks?
  lifted shadows?), overall temperature (warm/cool).
- Does it shift per section (e.g. cooler/more clinical for a CTA)?
- This becomes a rough mental model only — do NOT author a `StyleProfile`
  or reach for `backgroundReplace`/generated inserts; see formatContract.md's
  own "ADVANCED / OUT OF SCOPE" section for why.

## 6. Sound design

- Is there a music bed? Rough genre/energy/BPM feel (the spectrogram
  and waveform from `contact-sheets.sh` are enough to judge this without
  transcribing music).
- SFX vocabulary used (whoosh, click, ding, impact) and what they land on.
- Voice tone if there's narration (casual, authoritative, energetic) —
  informs the filming `instructions` you write per slot.

## 7. Beat map

Walk the transcript + shots in order and produce a table: for each beat,
its rough time range, what's spoken (paraphrased structurally, not
quoted), what's on screen, and any overlay/SFX firing. This table IS the
block list — one row usually becomes one block, in order.

---

## Originality rule (non-negotiable)

Model the *technique*, never reproduce the creator's actual words. Every
`example` and `instructions` string you write into the format must be
your own original phrasing describing the STRUCTURE ("say your hook line
here, matching the marker phrase"), not a copy of what this specific
creator said. A format that echoes the source creator's exact script
back to every future user isn't a template — it's a copy, and if reused
verbatim it gets algorithmically reach-suppressed as duplicate content
even on someone else's account. Abstract the topic into a niche
placeholder the way "5 Secret [Tool] Codes" abstracts a specific "Claude"
demo into "[Tool]."

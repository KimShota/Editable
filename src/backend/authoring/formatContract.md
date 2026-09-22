<!--
  The FormatSchema contract, in prose — read verbatim by synthesize.ts's
  multimodal prompt AND by the reel-to-template skill (an agent writing
  draft.json BY HAND instead of through the API call). Keeping this
  accurate to src/backend/pipeline/schemas.ts and
  src/backend/remotion/EdlVideo.tsx is what keeps drafts renderable —
  every field, every union variant, and the closed list of real renderer
  components it may reference are spelled out here because neither
  consumer ever sees the zod source directly.

  Scope: this covers every format-authoring feature that needs NOTHING
  beyond a draft.json to work. A separate "ADVANCED / OUT OF SCOPE"
  section at the bottom names the fields that exist in the schema but
  require checked-in template assets this stage can't produce on its
  own — don't reach for those unless a human has explicitly asked for
  that specific advanced path (see that section for why).
-->

Produce a JSON object of the shape `{"rationale": string, "format": FORMAT}`.

`"rationale"` is 2-4 sentences in plain English: what structural pattern you found (the beats, the pacing, why it likely works) — for a human reviewer, not consumed by any code.

FORMAT is a reusable, fill-in-the-blank template for THIS pipeline (not a description of the specific video — abstract the topic into a niche/placeholder the way "5 Secret [Tool] Codes" abstracts "Claude" into "[Tool]"):

```
{
  "id": string,                 // kebab-case slug, unique-sounding
  "name": string,                // e.g. "5 Secret [Tool] Codes" — bracket the part that varies by niche
  "niche": string,                // ONE WORD (e.g. "Gym", "Neuroscience", "Travel", "Work") — reuse an EXISTING niche listed below if it correlates, only mint a new one-word niche if none genuinely fit
  "description": string,          // 1-3 sentences: the structural pattern, for format pickers
  "fps": 30,
  "width": <source width>, "height": <source height>,   // match the analyzed video exactly
  "captionStyle": { "component": "Captions", "params": { "position": "lowerThird" } },  // omit only if the source has no burned-in captions
  "musicSlot": SLOT,             // OPTIONAL, mediaType "audio" — omit entirely if the reference has no distinct music bed for the user to supply
  "musicVolume": number,          // OPTIONAL, 0-1, default 0.5
  "musicPlacement": { "mode": "start", "fadeInSec": number, "fadeOutSec": number, "duckVolume": number },  // OPTIONAL — "start" (the common case) is the only mode this stage should author; see ADVANCED for the others
  "sharedSlots": [ { "name": string, "mediaType": "audio", "required": false, "instructions": string } ],  // SFX reused across multiple blocks (e.g. a recurring "ding"); OMIT the whole array if there's nothing shared
  "speakingTakeSlot": SLOT,       // OPTIONAL, mediaType "video" — see "ONE CONTINUOUS TAKE" below
  "finalClipSlot": SLOT,          // OPTIONAL, mediaType "video" — only meaningful alongside speakingTakeSlot
  "namesTakeSlot": SLOT,          // OPTIONAL, mediaType "video", must be required:true — see "ONE CONTINUOUS TAKE" below
  "blocks": [ BLOCK, ... ]
}
```

BLOCK (one per beat of the video — a hook, then each point/step/reveal, then a CTA — in the order they play):
```
{
  "id": string,          // kebab-case, unique within the format
  "title": string,       // human label, e.g. "Hook"
  "kind": "voice" | "broll",   // "voice" = the creator is talking and gets transcribed/anchored; "broll" = silent footage/screen-recording with no speech to anchor against
  "videoSlot": string,   // must equal the "name" of one of this block's own "slots" below (the main clip)
  "slots": [ SLOT, ... ], // every asset a user must film/supply for this block, INCLUDING the main clip
  "captions": boolean,    // true only for "voice" blocks where the source burns in word captions
  "captionVariant": "lowerThird" | "bigTitle" | "karaokeTitle",  // OPTIONAL, only meaningful alongside captions:true, default "lowerThird" — see CAPTIONS below
  "keywordTitle": { "source": "capture" | "llm", "maxWords": number },  // OPTIONAL, only meaningful alongside captionVariant:"bigTitle" — see CAPTIONS below
  "captionTheme": "kumar" | "outroYellow",  // OPTIONAL — omit to inherit the format's own captionStyle theme; "outroYellow" is a casual yellow lower-third for a block that deliberately breaks the cinematic tone (e.g. an outro/CTA)
  "anchors": [ ANCHOR, ... ],  // ONLY for "voice" blocks — omit/empty for "broll" (no transcript to anchor against)
  "events": [ EVENT, ... ],     // overlays/sfx that fire during this block
  "speed": number,        // OPTIONAL, default 1 — >1 plays this block's footage sped up (audio auto-mutes above 1x); use for a beat whose point is that it covers a long stretch of time (a commute, a practice session) compressed under a caption, matching a visible time-lapse cut in the reference
  "maxDurationSec": number,  // OPTIONAL hard cap on this block's own length after trim
  "optional": boolean,     // OPTIONAL, default false — voice blocks only: this beat is filmed as its OWN standalone clip (not a span of speakingTakeSlot) and is allowed to simply not exist in the final video if the user never films it (e.g. a bonus/CTA beat)
  "punchInTailSec": number,  // OPTIONAL, voice blocks only — crops+zooms the LAST N seconds of this block's own footage into a tight close-up cut, matching a reference reel's emphasis push-in at the end of a beat; free (uses the user's own footage, generates nothing)
  "ecuCutaway": { "atSec": number, "durationSec": number, "overlayAtSec": number },  // OPTIONAL, voice blocks only — an extreme-close-up cutaway: crops a short silent window of THIS SAME block's own footage (atSec/durationSec, relative to the block's own clip) and shows it as a hard cutaway elsewhere in the SAME block's timeline (overlayAtSec); free, matches a reference's cutaway-to-a-different-angle-of-the-same-shot rhythm
  "transitionAfter": { "component": "cut" | "fade" | "whooshZoom", "params": { "durationSec": number } }  // OMIT for a hard cut with no params object; include only if the source visibly transitions into the next block
}
```

SLOT (one thing the user must film/supply, with real filming direction — this is the founder-judgment part, be specific and concrete, not generic):
```
{ "name": string, "mediaType": "video" | "image" | "audio" | "text", "required": boolean, "instructions": string,
  "control": { "kind": "choice" | "orderedChoice", "options": [ { "value": string, "label"?: string, "color"?: string }, ... ] }  // OPTIONAL, mediaType "text" only — renders as a chip picker instead of free typing, for a slot whose reference clearly picks from a small fixed set (e.g. a tier letter). Omit entirely for any slot that should stay free text (the common case).
}
```
Every "voice" block's main clip slot must instruct the user to say a literal marker phrase matching that block's literal anchor phrasing (see ANCHOR below) — this is how the engine finds the block's own structure in EVERY user's differently-worded recording.

CAPTIONS — how the reference's on-screen text actually reads, block by block:
Most captioned blocks are `captionVariant: "lowerThird"` (the default) — an ordinary multi-word caption line, always built whenever `captions: true`. Two blocks read differently and need a different variant:
- `"bigTitle"`: the lowerThird line is ALSO joined by full-screen keyword-title cards for specific words — set `keywordTitle` to say which. `"source": "capture"` pulls from a literal anchor's own captured span (the words right after a `capture: true` anchor's marker phrase — free, needs nothing extra). `"source": "llm"` picks salient word(s) from the rest of the block's line instead, for a block whose anchor doesn't capture. `"maxWords"` bounds how many words get their own card (usually 1).
- `"karaokeTitle"`: REPLACES the lowerThird line entirely with one full-screen title card per word, shown one at a time — use only when the reference genuinely has no lower-third line at all, just one giant word at a time filling most of the frame.
`captionTheme: "outroYellow"` is for a block whose captions visibly break style from the rest of the video (commonly an outro/CTA in a casual yellow look) — leave unset otherwise.

ANCHOR — two kinds, only inside "voice" blocks:
```
  LITERAL (near-certain, no LLM; marks block structure and captures the user's own variable words):
    { "id": string, "kind": "literal", "phrases": [string, ...],  // 1+ ways a user might actually phrase the fixed instruction line, e.g. ["Number one is", "First is"]
      // When "capture" is true, EVERY phrase must contain ONLY the fixed marker words — never the variable words that follow, not even as an example. Listing "For research" beside "For" when "research" is what gets captured makes the phrase swallow the content and the capture come back empty, silently dropping every event timed off this anchor.
      "capture": boolean,        // true if the words right after the phrase are content to reuse (e.g. the user's own name for "code 1")
      "captureUntil": string,     // OPTIONAL: a fixed phrase that ends the capture
      "fallback": { "anchor": "blockStart" | "blockEnd", "offsetSec": number } }
  SEMANTIC (a free-form content moment, located by an LLM per real recording):
    { "id": string, "kind": "semantic", "description": string,   // plain-language description of the MEANING of the moment, e.g. "the pivot from problem to solution" — not keywords
      "form": string,   // OPTIONAL light constraint, e.g. "one sentence, starts with a verb"
      "window": { "afterAnchor": string, "beforeAnchor": string },  // OPTIONAL: bounds the search to between two LITERAL anchor ids IN THE SAME BLOCK (never a semantic anchor id)
      "fallback": { "anchor": "blockStart" | "blockEnd", "offsetSec": number }, "fallbackDurationSec": number }
```

EVENT (an overlay or sound effect that fires during a block; "id" must be unique across the WHOLE format):
```
{ "id": string, "kind": "overlay" | "sfx",
  "component": { "component": COMPONENT_NAME, "params": { ... } },
  "timing": TIMING,
  "durationSec": number,   // OPTIONAL — omit for an overlay that stays up until the block ends
  "until": TIMING,         // OPTIONAL — alternative to durationSec: ends exactly when another anchor/role fires
  "layout": { "x": number, "y": number, "width": number, "height": number },  // OPTIONAL, overlays only — the on-canvas box as a FRACTION of the frame (0-1), MEASURED from the frames you were shown. Omit only when the reference truly centers the element with nothing else on screen at the same time. See the mandatory rule below.
  "states": [ { "trigger": TIMING, "params": { ... } }, ... ],  // OPTIONAL, overlays only — additional param values that REPLACE this event's own params at a LATER moment in its lifetime (same component, no remount) — e.g. a card that starts blurred/white-labeled and becomes sharp/colored the instant the speaker names it. Each "trigger" is a TIMING (fixed or role — NOT sequence) tying the change to a specific word/anchor, exactly like the event's own "timing".
  "motion": { "enter": MOTION_PHASE, "exit": MOTION_PHASE }  // OPTIONAL, overlays only — see MOTION below. Omit entirely to use the component's own hardcoded default motion (fine for most overlays; author this only when the reference's entrance/exit is clearly distinctive — a slide, a specific overshoot, a slow fade — not a generic pop)
}
```

MOTION — an overlay's own enter/exit animation, when the reference's default pop-in/out isn't what's happening:
```
MOTION_PHASE = {
  "durationSec": number,
  "x": CHANNEL,       // OPTIONAL — fraction of composition WIDTH, offset from resting x; negative = left of rest (e.g. a slide-in from off-screen left starts around -0.6..-1 and animates to 0)
  "y": CHANNEL,        // OPTIONAL — fraction of composition HEIGHT, offset from resting y
  "scale": CHANNEL,     // OPTIONAL — absolute multiplier on the event's own rendered size (1 = normal)
  "rotate": CHANNEL,     // OPTIONAL — degrees, offset from the event's own authored orientation
  "opacity": CHANNEL      // OPTIONAL — absolute 0..1 (1 = fully visible)
}
CHANNEL = [ { "at": number (0..1, fraction of the PHASE's own duration), "value": number, "easing": EASING }, ... ]   // at least 2 keyframes; "easing" eases the segment INTO this keyframe from the previous one (ignored on the first keyframe) and defaults to linear
EASING = { "kind": "linear" } | { "kind": "cubicBezier", "x1": number, "y1": number, "x2": number, "y2": number } | { "kind": "spring", "damping": number, "mass": number, "stiffness": number }
```
An event with only `enter` animates in, then holds at rest until it disappears (today's default). Only `exit` pops in immediately and animates out. Both together is the common case for a distinctive slide/overshoot entrance paired with a plain fade-out — measure the timing directly off consecutive frames rather than guessing.

MANDATORY RULE — distinct simultaneous elements need distinct "layout": when the reference shows more than one image/card/element on screen AT THE SAME TIME in FIXED, DISTINCT positions (e.g. three logo cards side by side, a badge in a corner while another element is centered), EVERY one of those events MUST get its own "layout" box measured from the frame. Giving two simultaneous events the same box (or omitting "layout" on both) is a modeling mistake — they will render stacked on top of each other and unreadable. Only omit "layout" for an element that is truly alone on screen and should simply auto-center.

COMPONENT_NAME — a CLOSED list; using anything else means the overlay silently never renders:
```
  overlays: "TextOverlay" (params: "textSlot" OR "textAnchor"+"textTemplate", "variant": "hook"|"resolve"|"title"|"description"|"cta", "fontSize"?),
            "ImageOverlay" (params: "imageSlot": <a slot name of mediaType "image">, "label"? <a short text tag rendered ABOVE the image, e.g. "BAD"/"GOOD"/"GREAT">, "labelColor"? <hex color, sampled from the frame>, "blurred"? <true = renders as a blurred placeholder, for a card that starts blurred and is later revealed via a "states" entry setting "blurred": false>),
            "VideoOverlay" (params: "videoSlot": <a slot name of mediaType "video"> — a concurrent screen-recording/b-roll layered OVER the talking clip, muted, rendered as a floating picture-in-picture card),
            "CutawayOverlay" (params: "videoSlot": <a slot name of mediaType "video"> — a hard, FULL-FRAME cutaway that REPLACES what's visible while the block's own audio keeps playing underneath unbroken; this is what "ecuCutaway" above uses automatically, but a format can also author one directly against a separate broll/cutaway slot),
            "StickerTitle" (params: "textAnchor"+"textTemplate" containing "{captured}", "fontSize"? — a rotated sticky-note title card),
            "SkillCard" (params: "textAnchor", "imageSlot"? — a named-thing card with a preview image below it)
  sfx: always "Sfx" (params: "audioSlot": <a slot name of mediaType "audio", usually from sharedSlots>, "volume": 0-1)
```

Slot indirection in "component.params" (assemble-time, not literal values you invent):
```
  "textSlot": <slot name of mediaType "text"> → renders that slot's literal text
  "textAnchor": <anchor id in this block> + optional "textTemplate" containing the substring "{captured}" → renders that anchor's captured words (from a "capture": true literal anchor), inserted into the template
  "imageSlot" / "audioSlot" / "videoSlot": <slot name of the matching mediaType> → renders that user-supplied file
```

TIMING — when an event fires, one of:
```
  { "kind": "role", "roleId": <anchor id, same block>, "edge": "start" | "end" | "captureStart", "offsetSec": number }
  { "kind": "fixed", "anchor": "blockStart" | "blockEnd", "offsetSec": number }
  { "kind": "sequence", "roleId": <anchor id>, "edge": "start"|"end"|"captureStart", "index": number, "count": number, "targetGapSec": number }  // use for N sibling events evenly spaced after one anchor (e.g. a flip-through of preview images) — every sibling repeats the same roleId/count/targetGapSec, only "index" differs (0-based)
```

ONE CONTINUOUS TAKE — when the reference is filmed as a single unbroken recording (the creator never visibly cuts to a new camera setup between beats, e.g. a vlog-style walkthrough) rather than a separate clip per beat: set the format's own `speakingTakeSlot` (mediaType "video") instead of asking the user to film each voice block separately. Every voice block's own `videoSlot` binding is then automatically derived by locating that block's own literal-anchor marker phrase inside the ONE clip the user uploads to `speakingTakeSlot` — author the blocks exactly the same way otherwise (anchors, events, captions all work unchanged). `finalClipSlot` (mediaType "video") is for an optional separately-filmed clip that plays unedited at the very end. `namesTakeSlot` (mediaType "video", must be `required: true`) is for a reference that has the creator say a short name/label once per beat, back to back, as its own short separate recording (e.g. reading off a list of names) — pair it with a `nameTextSlot` on each relevant block (naming one of that block's own OPTIONAL text slots) to auto-fill that text from the names-take audio when the user hasn't typed one themselves, and time that block's reveal events off `"anchor": "nameAudioStart"` (a third AnchorPoint alongside blockStart/blockEnd) instead of a spoken-phrase anchor. Only use speakingTakeSlot/namesTakeSlot when the reference genuinely shows this pattern — most reels are filmed as separate per-beat clips and should stick to a per-block `videoSlot`.

---

## ADVANCED / OUT OF SCOPE FOR THIS STAGE

The schema also supports background replacement (`backgroundReplace`, `plateComposite`, `silhouette`), AI-generated inserts (`identitySlot`, a slot's own `generation` spec), a format-level `StyleProfile` (color grade + generation environment/lighting), and two components built for ONE specific existing format's own bespoke choreography (`TierBoard`'s whole-video `mergeGroup` state machine, `TriptychNameStamp`). All of these need checked-in template assets under `formats/assets/<id>/` (backdrop plates, a measured desk mask, framing targets) that this stage has no way to produce — they're built by hand or via `npm run reference:beats`/a dedicated asset-authoring pass, not invented from an LLM's read of a few sampled frames. `musicPlacement.mode` values other than `"start"` (`"montageOnset"`/`"endAlign"`) exist only to align with a `montageReel`-generated block, so they're moot without `generation` too.

Do not author any of these unless a human has explicitly asked for that specific reel to become a single-take/background-replaced format and understands the follow-up asset-building step required — for every ordinary reel, leave them out entirely and the format still renders correctly with real user-filmed footage in every slot.

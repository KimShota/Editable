# Editable

A library of proven, niche-specific viral video formats turned into
lego-block templates. Think of it as **the video-editing version of
NeetCode**: instead of teaching you to invent a viral structure from
scratch, it hands you a pattern that already works and shows you how to
fill it in.

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

## Quick start

```bash
npm install
npm run dev      # opens Remotion Studio to preview/scrub
```

Then render a final MP4:

```bash
npx remotion render CsResources out/video.mp4
```

## Plug in YOUR clips

The project ships with placeholder clips so it runs immediately. To make
your real video, replace the files in `public/clips/` and `public/audio/`,
keeping the EXACT same names:

| File                          | What it is                                  | Length (timecode @ 30fps) |
|-------------------------------|----------------------------------------------|---------------------------|
| `public/clips/hook.mp4`       | Desk / POV visual for the hook              | 00:00:02:28 (2.93s)        |
| `public/clips/resource-1.mp4` | Screen-recording of resource 1              | 00:00:01:23 (1.77s)        |
| `public/clips/resource-2.mp4` | Screen-recording of resource 2              | 00:00:01:19 (1.63s)        |
| `public/clips/resource-3.mp4` | Screen-recording of resource 3              | 00:00:01:18 (1.60s)        |
| `public/clips/cta.mp4`        | Desk / intellectual visual for the CTA      | 00:00:01:18 (1.60s)        |
| `public/audio/music.mp3`      | Your background track (the "okay" beat one) | 9.53s                      |

Clips can be longer than the listed length — only the first N seconds are
used. (Auto-trimming the clips themselves is a later feature; for now just
film roughly the right length.)

## Change YOUR text

Open `src/templates/csResources.ts` and edit the text fields:
- `textHook` — the painpoint (e.g. "I have NO projects on my resume")
- `resolveText` — the payoff (e.g. "GO HERE")
- each resource's `title` + `description`
- the `cta` `text`

## Sync "GO HERE" to the beat

In `src/templates/csResources.ts`, set the hook's `resolveAtFrame` to the
frame (within the hook block, at 30fps) where the "okay" beat hits in your
audio (currently frame 64, 00:02.14 / 2.14s in). Scrub in Remotion Studio to line it
up by eye/ear — each frame is 1/30s.

## How it's structured (so you can extend it)

- `src/templates/csResources.ts` — the FORMAT as data. New format = new file like this.
- `src/TemplateVideo.tsx` — generic renderer; reads any template config, lays out blocks.
- `src/components/` — the block renderers (Hook, Resource, Cta) + shared style.

To add a second template later, copy `csResources.ts`, change the blocks,
and register it in `src/Root.tsx`. No renderer changes needed.

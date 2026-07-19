# five-codes — drop your assets here

This job runs the **5 Secret [Tool] Codes** format. Drop each file at the
exact path below (or edit `job.json` to point at your filenames — any
common extension works as long as the path in `job.json` matches). Then:

```bash
npm run pipeline -- --job jobs/five-codes
```

## Talking clips — `assets/talking/` (film vertical, chest-up)

The **bold words are load-bearing**: the pipeline finds them in your
speech (literal anchors) to place title cards and capture your own names
for the codes. Everything else is yours to phrase freely.

| file | what to say |
| --- | --- |
| `hook.mp4` | **"Here are 5 secret** [tool] codes **that nobody** is talking about" — e.g. "…5 secret ChatGPT codes…". Your tool name is captured onto the title card. |
| `code1.mp4` | **"First is** [name]", then explain it in ONE sentence starting with a verb, ending on the payoff (benefit clause last). |
| `code2.mp4` | **"Second is** [name]", one-sentence explanation ending on the outcome, then one short bolder-promise sentence. |
| `code3.mp4` | **"Third is** [name]", one-sentence explanation ending on the result, then one flourish/analogy sentence ("it's like…"). |
| `code4.mp4` | **"Fourth is** [name]", one-sentence explanation, then the payoff in one sentence contrasted with the generic alternative. |
| `code5.mp4` | **"Final is** [name]", one sentence with two clauses — action, then twist — then the benefit in one sentence. |
| `cta.mp4` | **"Comment** [keyword] **and I'll** hand you all the codes" — the click SFX lands on your keyword. |

## Screen recordings — `assets/screens/`

`code1.mp4` … `code4.mp4` — the code/tool in action, a few seconds each.
They play concurrently over you while you explain (code 5 uses a gif
instead).

## Images — `assets/images/`

- `preview-1.png` … `preview-5.png` — hook teaser cards, flipped through after the hook line
- `result-1.png`, `result-2.png` — code 3's result screenshots, flashed on the result clause

## Memes — `assets/memes/`

- `code1-punchline.png` — pops on code 1's benefit clause
- `code2-reaction.png` / `code2-punchline.png` — outcome clause / extra claim
- `code3-punchline.png` — flourish sentence
- `code4-positive.png` / `code4-punchline.png` — payoff clause / contrast clause
- `code5-reaction.png` / `code5-punchline.png` — twist clause / benefit sentence

## Gif — `assets/gifs/`

`code5-reaction.gif` — animated reaction gif, plays on code 5's action clause.

## SFX — `assets/sfx/` (short, CC0 or owned)

`bell.wav` (title cards), `click.wav` (previews, screenshots, CTA keyword),
`typing.wav` (under screen recordings, gets cut to fit), `punchline.wav`,
`shutter.wav` (hook title card), `reaction.wav`, `reaction2.wav`,
`positive.wav`.

## Music — `assets/music/` (optional)

`music.mp3` — a bed you own. Skippable: delete its line from `job.json`
and add trending audio in the posting app instead.

SFX and memes are optional in the format — if one is missing the pipeline
warns and skips that event rather than failing. The talking clips,
screens, and images are required.

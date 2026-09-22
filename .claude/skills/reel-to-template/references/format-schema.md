# Format schema

The real, single source of truth for `FORMAT` (what goes in
`draft.json`'s `"format"` key) is:

```
src/backend/authoring/formatContract.md
```

Read that file directly — it's the exact same prose contract
`synthesize.ts` feeds the API when the web app authors a draft, so
anything written by hand here follows it will validate and render the
same way. Don't duplicate it here; a second copy would drift.

Two things worth knowing before you open it:

- It's split into a main contract (everything that needs nothing beyond
  `draft.json` itself) and an **ADVANCED / OUT OF SCOPE** section at the
  bottom (background replacement, AI-generated inserts, `StyleProfile`,
  the two bespoke single-format components `TierBoard`/
  `TriptychNameStamp`). Don't reach into that section unless a human has
  explicitly asked for that specific advanced path — every ordinary reel
  authors correctly without it.
- The underlying zod schema lives in `src/backend/pipeline/schemas.ts`
  (`FormatSchema`, `BlockSchema`, `SlotSchema`, `FormatEventSchema`, …) —
  only worth opening directly if `--only validate`'s error references a
  field the contract doesn't explain clearly enough.

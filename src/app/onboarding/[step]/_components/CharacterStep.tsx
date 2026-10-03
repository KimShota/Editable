"use client";

import { useState } from "react";
import { ReplayGate } from "./ReplayGate";

/**
 * Step 2: from concepts to a locked character sheet, in four stages that
 * mirror how it was made: pick a concept, pick a drawing, refine it, lock it.
 * Everything shown is what was really generated for this brand.
 */

export type ConceptView = { index: number; name: string; form: string; oneLine: string; personality: string[]; signatureProp: string; catchphrase: string };
export type ImageView = { name: string; url: string };
export type CharacterData = {
  slug: string;
  paceMs: number;
  concepts: ConceptView[];
  chosenConcept: number;
  variations: ImageView[];
  refinements: ImageView[];
  base: ImageView;
  characterName: string;
  kind: "realistic" | "mascot";
  sheet: { view: string; url: string }[];
};

type Stage = "concepts" | "drawings" | "refine" | "lock";
const ORDER: { id: Stage; label: string }[] = [
  { id: "concepts", label: "Concepts" },
  { id: "drawings", label: "Drawings" },
  { id: "refine", label: "Refine" },
  { id: "lock", label: "Lock" },
];

const VIEW_LABELS: Record<string, string> = {
  front: "Front",
  three_quarter: "Three quarters",
  side: "Side",
  back: "Back",
  happy: "Happy",
  surprised: "Surprised",
  thinking: "Thinking",
  presenting: "Presenting",
  with_prop: "With its prop",
};

const primary = "rounded-full bg-[color:var(--ink)] px-6 py-2.5 font-[family-name:var(--font-display)] text-sm font-bold tracking-wide text-[color:var(--bg)] transition-transform hover:scale-[1.03] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]";

export function CharacterStep(d: CharacterData) {
  const [stage, setStage] = useState<Stage>("concepts");
  const [concept, setConcept] = useState(d.chosenConcept);
  const [drawing, setDrawing] = useState(d.variations[0]?.name ?? d.base.name);
  const [refined, setRefined] = useState(d.base.name);
  const at = ORDER.findIndex((s) => s.id === stage);
  const picked = d.concepts.find((c) => c.index === concept);

  return (
    <div className="flex flex-col gap-8">
      <ol aria-label="Character stages" className="flex gap-4 text-sm">
        {ORDER.map((s, i) => (
          <li key={s.id} aria-current={i === at ? "step" : undefined} className={i === at ? "font-semibold text-[color:var(--ink)]" : "text-[color:var(--ink-dim)]"}>
            {s.label}
          </li>
        ))}
      </ol>

      {stage === "concepts" && (
        <ReplayGate id={`${d.slug}.character.concepts`} title="Imagining characters" steps={[{ stage: "Reading your brand" }, { stage: "Imagining characters" }]} durationMs={3000 * d.paceMs}>
          <fieldset>
            <legend className="mb-3 text-sm font-medium text-[color:var(--ink)]">Which character feels like your brand?</legend>
            <div className="grid gap-3 md:grid-cols-2">
              {d.concepts.map((c) => (
                <label key={c.index} className={`flex cursor-pointer flex-col gap-2 rounded-2xl border p-4 ${concept === c.index ? "border-[color:var(--ink)] bg-[color:var(--card)]" : "border-[color:var(--card-border)]"}`}>
                  <span className="flex items-center gap-2 font-[family-name:var(--font-display)] text-base font-semibold text-[color:var(--ink)]">
                    <input type="radio" name="concept" checked={concept === c.index} onChange={() => setConcept(c.index)} />
                    {c.name}
                  </span>
                  <span className="text-sm text-[color:var(--ink)]">{c.oneLine}</span>
                  <span className="text-[13px] text-[color:var(--ink-dim)]">{c.form}</span>
                  <ul className="flex flex-wrap gap-1.5" aria-label={`${c.name}'s personality`}>
                    {c.personality.map((p) => (
                      <li key={p} className="rounded-full bg-[color:var(--bg-2)] px-2.5 py-0.5 text-xs text-[color:var(--ink)]">{p}</li>
                    ))}
                  </ul>
                  <span className="text-[13px] text-[color:var(--ink-dim)]">Catchphrase: &ldquo;{c.catchphrase}&rdquo;</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="mt-6">
            <button type="button" className={primary} onClick={() => setStage("drawings")}>See {picked?.name ?? "it"} drawn</button>
          </div>
        </ReplayGate>
      )}

      {stage === "drawings" && (
        <ReplayGate id={`${d.slug}.character.drawings`} title="Drawing the first versions" steps={[{ stage: "Drawing the first versions" }]} durationMs={3500 * d.paceMs}>
          <fieldset>
            <legend className="mb-3 text-sm font-medium text-[color:var(--ink)]">Pick the one that looks right</legend>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {d.variations.map((v) => (
                <li key={v.name}>
                  <label className={`block cursor-pointer overflow-hidden rounded-2xl border-2 ${drawing === v.name ? "border-[color:var(--ink)]" : "border-transparent"}`}>
                    <img src={v.url} alt={`Drawing ${v.name}`} className="aspect-[3/4] w-full bg-[color:var(--bg-2)] object-cover" />
                    <span className="flex items-center gap-2 px-2 py-2 text-sm text-[color:var(--ink)]">
                      <input type="radio" name="drawing" checked={drawing === v.name} onChange={() => setDrawing(v.name)} />
                      Version {v.name.split("-v")[1] !== undefined ? Number(v.name.split("-v")[1]) + 1 : ""}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <div className="mt-6 flex gap-3">
            <button type="button" onClick={() => setStage("concepts")} className="rounded-full border border-[color:var(--card-border)] px-5 py-2.5 text-sm font-medium text-[color:var(--ink)]">Back</button>
            <button type="button" className={primary} onClick={() => setStage("refine")}>Refine this one</button>
          </div>
        </ReplayGate>
      )}

      {stage === "refine" && (
        <ReplayGate id={`${d.slug}.character.refine`} title="Refining the face and outfit" steps={[{ stage: "Refining the face and outfit" }]} durationMs={3000 * d.paceMs}>
          <div className="grid gap-6 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
            <figure>
              <img src={d.variations.find((v) => v.name === drawing)?.url ?? d.base.url} alt="The drawing you picked" className="aspect-[3/4] w-full rounded-2xl bg-[color:var(--bg-2)] object-cover" />
              <figcaption className="mt-2 text-sm text-[color:var(--ink-dim)]">Your pick</figcaption>
            </figure>
            <div className="flex flex-col gap-4">
              <div>
                <label htmlFor="refine-note" className="mb-2 block text-sm font-medium text-[color:var(--ink)]">Describe a change, or add a reference photo</label>
                <textarea id="refine-note" disabled rows={2} placeholder="Softer smile, a black top" className="w-full rounded-lg border border-[color:var(--card-border)] bg-[color:var(--bg-2)] px-4 py-3 text-sm text-[color:var(--ink-dim)]" />
                <p className="mt-1.5 text-[13px] text-[color:var(--ink-dim)]">In the replay the refinements are already made.</p>
              </div>
              <fieldset>
                <legend className="mb-2 text-sm font-medium text-[color:var(--ink)]">Refinements</legend>
                <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                  {d.refinements.map((r) => (
                    <li key={r.name}>
                      <label className={`block cursor-pointer overflow-hidden rounded-2xl border-2 ${refined === r.name ? "border-[color:var(--ink)]" : "border-transparent"}`}>
                        <img src={r.url} alt={`Refinement ${r.name}`} className="aspect-[3/4] w-full bg-[color:var(--bg-2)] object-cover" />
                        <span className="flex items-center gap-2 px-2 py-2 text-sm text-[color:var(--ink)]">
                          <input type="radio" name="refinement" checked={refined === r.name} onChange={() => setRefined(r.name)} />
                          {r.name === d.base.name ? "Chosen" : "Option"}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            </div>
          </div>
          <div className="mt-6 flex gap-3">
            <button type="button" onClick={() => setStage("drawings")} className="rounded-full border border-[color:var(--card-border)] px-5 py-2.5 text-sm font-medium text-[color:var(--ink)]">Back</button>
            <button type="button" className={primary} onClick={() => setStage("lock")}>Lock this character</button>
          </div>
        </ReplayGate>
      )}

      {stage === "lock" && (
        <ReplayGate id={`${d.slug}.character.lock`} title="Building the character sheet" steps={[{ stage: "Drawing every angle" }, { stage: "Checking it is the same person" }, { stage: "Locking the sheet" }]} durationMs={4000 * d.paceMs}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold text-[color:var(--ink)]">{d.characterName}</h2>
            <p className="inline-flex items-center gap-2 rounded-full bg-[color:var(--bg-2)] px-3 py-1 text-sm text-[color:var(--ink)]" data-testid="locked">
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none">
                <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="2" />
                <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" />
              </svg>
              Locked for this brand
            </p>
          </div>
          <p className="mt-1 text-sm text-[color:var(--ink-dim)]">{d.kind === "realistic" ? "A realistic creator" : "A mascot"}. Every video uses this sheet, so it always looks like the same one.</p>
          <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="Character sheet">
            {d.sheet.map((s) => (
              <li key={s.view}>
                <img src={s.url} alt={`${d.characterName}, ${VIEW_LABELS[s.view] ?? s.view}`} className="aspect-[3/4] w-full rounded-xl bg-[color:var(--bg-2)] object-cover" />
                <p className="mt-1.5 text-[13px] text-[color:var(--ink-dim)]">{VIEW_LABELS[s.view] ?? s.view}</p>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-[color:var(--ink-dim)]">Need a change later? Contact us.</p>
          <div className="mt-4">
            <button type="button" onClick={() => setStage("refine")} className="text-sm font-medium text-[color:var(--ink-dim)] underline-offset-4 hover:text-[color:var(--ink)] hover:underline">Back to refining</button>
          </div>
        </ReplayGate>
      )}
    </div>
  );
}

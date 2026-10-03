"use client";

import { useState } from "react";
import { ReplayGate } from "./ReplayGate";

/**
 * Step 3: audition voices speaking the same line, pick one, hear the
 * character say its sample line, lock it. The audio is what was really
 * generated for this brand.
 */

export type AuditionView = { name: string; url: string; kind: "library" | "designed"; chosen: boolean };
export type VoiceData = { slug: string; paceMs: number; auditions: AuditionView[]; characterName: string; voiceName: string; sampleUrl: string | null; portraitUrl: string | null };

const primary = "rounded-full bg-[color:var(--ink)] px-6 py-2.5 font-[family-name:var(--font-display)] text-sm font-bold tracking-wide text-[color:var(--bg)] transition-transform hover:scale-[1.03] disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]";

export function VoiceStep(d: VoiceData) {
  const real = d.auditions.find((a) => a.chosen)?.name ?? d.auditions[0]?.name ?? "";
  const [picked, setPicked] = useState(real);
  const [locked, setLocked] = useState(false);

  return (
    <ReplayGate id={`${d.slug}.voice`} title="Auditioning voices" steps={[{ stage: "Searching voices" }, { stage: "Recording the same line in each" }]} durationMs={3500 * d.paceMs}>
      {d.auditions.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-[color:var(--card-border)] px-5 py-10 text-center text-[15px] text-[color:var(--ink-dim)]">No voices were auditioned for this brand.</p>
      ) : (
        <div className="flex flex-col gap-8">
          <fieldset disabled={locked} className="min-w-0">
            <legend className="mb-3 text-sm font-medium text-[color:var(--ink)]">Each one says the same line. Listen, then choose.</legend>
            <ul className="grid gap-3 md:grid-cols-3">
              {d.auditions.map((a, i) => (
                <li key={a.name} className={`flex flex-col gap-3 rounded-2xl border p-4 ${picked === a.name ? "border-[color:var(--ink)] bg-[color:var(--card)]" : "border-[color:var(--card-border)]"}`}>
                  <label className="flex cursor-pointer items-center gap-2 font-[family-name:var(--font-display)] text-base font-semibold text-[color:var(--ink)]">
                    <input type="radio" name="voice" checked={picked === a.name} onChange={() => setPicked(a.name)} />
                    Voice {String.fromCharCode(65 + i)}
                  </label>
                  <p className="text-[13px] text-[color:var(--ink-dim)]">{a.kind === "designed" ? "Designed from a description" : "From the voice library"}</p>
                  <audio controls preload="none" src={a.url} aria-label={`Voice ${String.fromCharCode(65 + i)} saying the line`} className="w-full" />
                </li>
              ))}
            </ul>
          </fieldset>

          <section aria-labelledby="sample-title" className="flex flex-col gap-4 rounded-2xl bg-[color:var(--bg-2)] p-5 sm:flex-row sm:items-center">
            {d.portraitUrl && <img src={d.portraitUrl} alt={d.characterName} className="h-28 w-20 shrink-0 rounded-xl object-cover" />}
            <div className="min-w-0 flex-1">
              <h2 id="sample-title" className="font-[family-name:var(--font-display)] text-base font-semibold text-[color:var(--ink)]">Hear {d.characterName} say it</h2>
              {picked === real && d.sampleUrl ? (
                <>
                  <p className="mt-1 text-sm text-[color:var(--ink-dim)]">{d.voiceName}</p>
                  <audio controls preload="none" src={d.sampleUrl} aria-label={`${d.characterName} speaking in ${d.voiceName}`} className="mt-3 w-full" />
                </>
              ) : (
                <p className="mt-1 text-sm text-[color:var(--ink-dim)]">In this replay only the voice that was chosen has a recording of {d.characterName}.</p>
              )}
            </div>
          </section>

          <div className="flex flex-wrap items-center gap-4">
            {locked ? (
              <p className="inline-flex items-center gap-2 rounded-full bg-[color:var(--bg-2)] px-3 py-1.5 text-sm text-[color:var(--ink)]" data-testid="voice-locked">
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="2" />
                  <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" />
                </svg>
                Locked for this brand
              </p>
            ) : (
              <button type="button" className={primary} onClick={() => setLocked(true)}>Lock this voice</button>
            )}
            <p className="text-sm text-[color:var(--ink-dim)]">One voice per character. Changing it later means contacting us.</p>
          </div>
        </div>
      )}
    </ReplayGate>
  );
}

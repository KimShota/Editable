"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { sendJson } from "../../../lib/clientApi";
import { TaskProgress } from "../../../_components/TaskProgress";
import { ReplayGate } from "./ReplayGate";

/**
 * Step 4: the angle the first cycle is about. Claude proposes 3 to 5 (a few
 * cents, started by the founder), the customer picks one, and it is locked
 * for the 14 days. What is actually working in each angle (live evidence)
 * arrives with research at launch, and the screen says so.
 */

export type AngleView = { id: string; title: string; whyItFits: string; exampleHooks: string[] };
export type NicheData = {
  slug: string;
  paceMs: number;
  angles: AngleView[];
  chosenId: string | null;
  /** The angle a plan has already locked in, if any. */
  lockedTitle: string | null;
  isAdmin: boolean;
  poolThumbs: string[];
  nextHref: string;
};

const primary = "rounded-full bg-[color:var(--ink)] px-6 py-2.5 font-[family-name:var(--font-display)] text-sm font-bold tracking-wide text-[color:var(--bg)] transition-transform hover:scale-[1.03] disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]";

export function NicheStep(d: NicheData) {
  const router = useRouter();
  const [picked, setPicked] = useState<string | null>(d.chosenId);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<number | null>(null);
  const locked = d.lockedTitle !== null;

  const propose = async () => {
    setBusy("propose");
    setError(null);
    const res = await sendJson<{ taskId: number | null }>(`/api/admin/brands/${d.slug}/niche`, {});
    setBusy(null);
    if (!res.ok) return setError(res.error);
    setTaskId(res.data.taskId);
  };

  const choose = async () => {
    if (!picked) return;
    setBusy("choose");
    setError(null);
    const res = await sendJson(`/api/brands/${d.slug}/niche`, { angleId: picked });
    setBusy(null);
    if (!res.ok) return setError(res.error);
    router.push(d.nextHref);
  };

  const nav = (
    <div className="mt-8 flex justify-end">
      <button type="button" className={primary} onClick={choose} disabled={!picked || busy !== null}>
        {busy === "choose" ? "Saving" : "Use this angle"}
      </button>
    </div>
  );

  if (d.angles.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-3xl border border-dashed border-[color:var(--card-border)] px-6 py-14 text-center">
        <p className="font-[family-name:var(--font-display)] text-lg font-semibold text-[color:var(--ink)]">No angles proposed yet</p>
        <p className="mt-2 max-w-md text-[15px] text-[color:var(--ink-dim)]">We suggest 3 to 5 ways to build your videos around the product, and you pick one.</p>
        {d.isAdmin && (
          <div className="mt-6 flex flex-col items-center gap-3">
            <button type="button" className={primary} onClick={propose} disabled={busy !== null || taskId !== null}>
              {busy === "propose" ? "Starting" : "Propose angles"}
            </button>
            <p className="text-[13px] text-[color:var(--ink-dim)]">This asks the AI and costs a few cents.</p>
            {error && <p role="alert" className="text-sm text-[color:var(--st-bad-fg)]">{error}</p>}
            {taskId !== null && <TaskProgress taskId={taskId} title="Finding angles that fit" onDone={() => router.refresh()} className="w-full max-w-sm text-left" />}
          </div>
        )}
      </div>
    );
  }

  return (
    <ReplayGate id={`${d.slug}.niche`} title="Finding angles that fit" steps={[{ stage: "Looking at your product" }, { stage: "Finding angles that fit" }]} durationMs={3000 * d.paceMs}>
      {locked && (
        <p role="status" className="mb-5 rounded-xl bg-[color:var(--bg-2)] px-4 py-3 text-sm text-[color:var(--ink)]">
          Your angle for this cycle is <strong>{d.lockedTitle}</strong>. It can change when the next cycle starts.
        </p>
      )}
      <fieldset disabled={locked}>
        <legend className="mb-3 text-sm font-medium text-[color:var(--ink)]">Choose one</legend>
        <div className="grid gap-3 md:grid-cols-2">
          {d.angles.map((a) => (
            <label key={a.id} data-angle={a.id} className={`flex cursor-pointer flex-col gap-3 rounded-2xl border p-5 ${picked === a.id ? "border-[color:var(--ink)] bg-[color:var(--card)]" : "border-[color:var(--card-border)]"} ${locked && picked !== a.id ? "opacity-50" : ""}`}>
              <span className="flex items-center gap-2 font-[family-name:var(--font-display)] text-base font-semibold text-[color:var(--ink)]">
                <input type="radio" name="angle" checked={picked === a.id} onChange={() => setPicked(a.id)} />
                {a.title}
              </span>
              <span className="text-sm leading-relaxed text-[color:var(--ink-dim)]">{a.whyItFits}</span>
              <ul className="flex flex-col gap-1.5 text-sm text-[color:var(--ink)]" aria-label={`Example openings for ${a.title}`}>
                {a.exampleHooks.map((h) => (
                  <li key={h}>&ldquo;{h}&rdquo;</li>
                ))}
              </ul>
            </label>
          ))}
        </div>
      </fieldset>

      <section aria-labelledby="evidence-title" className="mt-8">
        <h2 id="evidence-title" className="font-[family-name:var(--font-display)] text-base font-semibold text-[color:var(--ink)]">What is working</h2>
        {d.poolThumbs.length > 0 && (
          <ul className="mt-3 flex gap-2" aria-label="Viral videos we can recreate">
            {d.poolThumbs.map((u) => (
              <li key={u}>
                <img src={u} alt="" className="h-20 w-14 rounded-lg bg-[color:var(--bg-2)] object-cover" />
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 max-w-[65ch] text-sm text-[color:var(--ink-dim)]">These are viral videos we can recreate for you. Proof of what is working in each angle comes with live research at launch.</p>
      </section>

      {error && <p role="alert" className="mt-4 text-sm text-[color:var(--st-bad-fg)]">{error}</p>}
      {nav}
    </ReplayGate>
  );
}

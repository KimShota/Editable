"use client";

import Link from "next/link";
import { ReplayGate } from "./ReplayGate";

/** Step 5: the first 14 days, built from the angle. Shows the real plan's size. */
export function PlanStep({ slug, paceMs, videos, nicheTitle }: { slug: string; paceMs: number; videos: number; nicheTitle: string | null }) {
  return (
    <ReplayGate
      id={`${slug}.plan`}
      title="Building your 14-day plan"
      steps={[{ stage: "Choosing the formats" }, { stage: "Writing the scripts" }, { stage: "Setting the schedule" }]}
      durationMs={4000 * paceMs}
    >
      <div className="flex flex-col items-start gap-4">
        <p className="text-lg text-[color:var(--ink)]" data-testid="plan-summary">
          {videos > 0 ? `${videos} video${videos === 1 ? "" : "s"} planned for your first 14 days.` : "Your plan is ready to be built."}
        </p>
        {nicheTitle && <p className="text-[15px] text-[color:var(--ink-dim)]">Angle: {nicheTitle}</p>}
        <p className="max-w-[65ch] text-[15px] text-[color:var(--ink-dim)]">Each day has a script written from a video that already works. Read them, change what you like, and approve the ones you want made. Nothing is created until you do.</p>
        <Link href="/plan" className="rounded-full bg-[color:var(--ink)] px-6 py-3 font-[family-name:var(--font-display)] text-sm font-bold tracking-wide text-[color:var(--bg)] transition-transform hover:scale-[1.03] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]">
          Review your plan
        </Link>
      </div>
    </ReplayGate>
  );
}

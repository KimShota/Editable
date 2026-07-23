"use client";

import { useState } from "react";
import type { HookFeedbackResult } from "@backend/content/types";
import { Button, Pill } from "../../../../_components/ui";

/** On-demand critique of the hook — the highest-leverage single moment.
 *  Works whether the hook is already filmed (transcribes just that clip)
 *  or only has a script suggestion so far (critiques that instead). */
export function HookFeedbackPanel({
  jobId,
  initialFeedback,
}: {
  jobId: string;
  initialFeedback: HookFeedbackResult | null;
}) {
  const [feedback, setFeedback] = useState(initialFeedback);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getFeedback = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/hook-feedback`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "feedback failed");
      setFeedback(data.feedback);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 border-t border-white/10 pt-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium text-[color:var(--ink)]">Hook feedback</p>
        <Button variant="secondary" onClick={getFeedback} disabled={busy} className="!px-3 !py-1.5 text-xs">
          {busy ? "Scoring…" : feedback ? "Re-check" : "Get hook feedback"}
        </Button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {feedback && (
        <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-black/20 p-4">
          <div className="flex items-center gap-2">
            <Pill tone="accent">{feedback.score}/10</Pill>
            <Pill>{feedback.source === "filmed" ? "from your filmed clip" : "from suggested script"}</Pill>
          </div>
          <p className="text-sm text-[color:var(--ink-dim)]">{feedback.critique}</p>
          {feedback.alternatives.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] tracking-wide text-[color:var(--ink-faint)] uppercase">Try instead</p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-[color:var(--ink)]">
                {feedback.alternatives.map((alt, i) => (
                  <li key={i}>{alt}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

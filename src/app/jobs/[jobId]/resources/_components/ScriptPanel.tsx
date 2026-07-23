"use client";

import { useState } from "react";
import type { ScriptSuggestion } from "@backend/content/types";
import { Button, Card } from "../../../../_components/ui";

/** Topic input + "Generate" — the aid for the "what do I actually say" gap
 *  between a format's generic filming instructions and one creator's real
 *  content. Suggestions render as hints per-slot in ResourcesBoard, keyed
 *  by blockId/slotName. */
export function ScriptPanel({
  jobId,
  script,
  onScriptUpdated,
}: {
  jobId: string;
  script: ScriptSuggestion | null;
  onScriptUpdated: (script: ScriptSuggestion) => void;
}) {
  const [topic, setTopic] = useState(script?.topic ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(!script);

  const generate = async () => {
    if (!topic.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/script`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: topic.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "generation failed");
      onScriptUpdated(data.script);
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-[family-name:var(--font-display)] text-lg font-bold text-[color:var(--ink)]">
            Script suggestions
          </h2>
          <p className="text-sm text-[color:var(--ink-dim)]">
            {script
              ? `Suggested lines for "${script.topic}" — shown as hints above each slot below.`
              : "Tell us what this video is about and we'll suggest a line for every slot."}
          </p>
        </div>
        {!open && (
          <button onClick={() => setOpen(true)} className="text-sm font-medium text-[color:var(--accent)]">
            {script ? "Regenerate" : "Generate"}
          </button>
        )}
      </div>
      {open && (
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="e.g. Claude coding tips for beginners"
            className="min-w-[240px] flex-1 rounded-lg border border-white/12 bg-black/20 px-3 py-2 text-sm text-[color:var(--ink)] outline-none focus:border-[color:var(--accent)]"
          />
          <Button onClick={generate} disabled={busy || !topic.trim()} className="!px-4 !py-2 text-sm">
            {busy ? "Writing…" : "Generate"}
          </Button>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </Card>
  );
}

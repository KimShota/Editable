"use client";

import { useState } from "react";
import type { Format } from "@backend/pipeline/types";
import type { ScriptSuggestion } from "@backend/content/types";
import { Card, LineKind, Pill } from "../../../../_components/ui";

const persistScript = async (jobId: string, script: ScriptSuggestion): Promise<ScriptSuggestion> => {
  const res = await fetch(`/api/jobs/${jobId}/script`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "save failed");
  return data.script;
};

const BrollIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="text-[color:var(--ink-dim)]">
    <path d="M4 4h16v16H4z" stroke="currentColor" strokeWidth="1.5" />
    <path d="M4 9h16M9 4v16" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

/**
 * A line-by-line view of the whole format's spoken sequence: a numbered
 * circle per voice block (matching how a viewer actually experiences the
 * beats), with a small separator row wherever a silent b-roll/generated
 * block sits between them — the same visual idea as a "cutaway shot"
 * marker, labeled with what that beat actually is in THIS format rather
 * than a generic fixed word.
 *
 * Editing a line here is a planning aid, not a script that must be read
 * verbatim: Editable's anchors fuzzy-match whatever is actually said when
 * filming, and a captured value (like a name) comes straight from the
 * literal anchor's `capture: true` — there's no separate "type your name"
 * step, because the spoken take already supplies it.
 */
export function ScriptLines({
  jobId,
  format,
  script,
  onScriptUpdated,
}: {
  jobId: string;
  format: Format;
  script: ScriptSuggestion | null;
  onScriptUpdated: (script: ScriptSuggestion) => void;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lineFor = (blockId: string, slotName: string): string =>
    script?.suggestions.find((s) => s.blockId === blockId && s.slotName === slotName)?.text ?? "";

  const saveLine = async (blockId: string, slotName: string, text: string) => {
    const base: ScriptSuggestion = script ?? { topic: "", createdAt: new Date().toISOString(), suggestions: [] };
    const next: ScriptSuggestion = {
      ...base,
      suggestions: [
        ...base.suggestions.filter((s) => !(s.blockId === blockId && s.slotName === slotName)),
        { blockId, slotName, text },
      ],
    };
    setSaving(slotName);
    setError(null);
    try {
      onScriptUpdated(await persistScript(jobId, next));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  };

  let lineNumber = 0;

  return (
    <Card className="p-6">
      <h2 className="mb-6 font-[family-name:var(--font-display)] text-lg font-bold text-[color:var(--ink)]">
        Your lines
      </h2>
      <div className="flex flex-col">
        {format.blocks.map((block, i) => {
          if (block.kind !== "voice") {
            return (
              <div key={block.id} className="flex items-center gap-3 py-3 pl-1">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/15 bg-black/30">
                  <BrollIcon />
                </span>
                <span className="text-sm text-[color:var(--ink-dim)]">{block.title}</span>
                <Pill>{block.slots.some((s) => s.generation) ? "auto-generated" : "b-roll"}</Pill>
              </div>
            );
          }
          lineNumber += 1;
          const text = lineFor(block.id, block.videoSlot);
          return (
            <div key={block.id} className={`flex items-start gap-3 py-2 pl-1 ${i > 0 ? "border-t border-white/5" : ""}`}>
              <span className="mt-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color:var(--accent)] text-xs font-bold text-[color:var(--accent-ink)]">
                {lineNumber}
              </span>
              <div className="flex-1 pt-1">
                <div className="mb-2 flex items-center gap-2">
                  <LineKind kind="spoken" />
                </div>
                <p className="mb-2 text-[12px] leading-snug text-[color:var(--ink-dim)]">
                  {block.slots.find((s) => s.name === block.videoSlot)?.instructions ?? block.title}
                </p>
                <textarea
                  defaultValue={text}
                  onBlur={(e) => {
                    const value = e.target.value;
                    if (value !== text) saveLine(block.id, block.videoSlot, value);
                  }}
                  rows={2}
                  className="w-full resize-none rounded-lg border border-white/12 bg-black/20 p-3 text-sm text-[color:var(--ink)] outline-none focus:border-[color:var(--accent)]"
                />
                <p className="mt-1 text-[11px] text-[color:var(--ink-dim)]">
                  Example — Here are 5 secret ChatGPT codes that nobody is talking about.
                </p>
                {saving === block.videoSlot && (
                  <p className="mt-1 text-xs text-[color:var(--ink-dim)]">Saving…</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
    </Card>
  );
}

"use client";

import { useState } from "react";
import type { Block, Format } from "@backend/pipeline/types";
import type { ScriptSuggestion } from "@backend/content/types";
import { Card, LineKind, Pill } from "../../../../_components/ui";
import { Binding, SlotDropzone } from "./SlotDropzone";
import { BlockTextPreview } from "./BlockTextPreview";
import { slotLabel } from "../../../../lib/slotLabel";

const persistScript = async (
  jobId: string,
  script: ScriptSuggestion,
): Promise<ScriptSuggestion> => {
  const res = await fetch(`/api/jobs/${jobId}/script`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "save failed");
  return data.script;
};

/** The spoken-line field: same visual shell as a text slot (label, one
 *  textarea, inline status), but saves to the job's `script` suggestions
 *  store keyed by blockId/videoSlot rather than the assets/bindings store a
 *  real text slot uses — the two systems live side by side because that's
 *  where the backend actually keeps this value (see ResourcesBoard's
 *  `hookBlock`/`applySuggestion`), not by choice of this component. */
function SpokenLineField({
  jobId,
  block,
  videoSlot,
  script,
  onScriptUpdated,
  onDraftChange,
}: {
  jobId: string;
  block: Block;
  videoSlot: Block["slots"][number] | undefined;
  script: ScriptSuggestion | null;
  onScriptUpdated: (script: ScriptSuggestion) => void;
  onDraftChange: (value: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text =
    script?.suggestions.find(
      (s) => s.blockId === block.id && s.slotName === block.videoSlot,
    )?.text ?? "";
  const filled = text.trim().length > 0;

  const save = async (value: string) => {
    const base: ScriptSuggestion = script ?? {
      topic: "",
      createdAt: new Date().toISOString(),
      suggestions: [],
    };
    const next: ScriptSuggestion = {
      ...base,
      suggestions: [
        ...base.suggestions.filter(
          (s) => !(s.blockId === block.id && s.slotName === block.videoSlot),
        ),
        { blockId: block.id, slotName: block.videoSlot, text: value },
      ],
    };
    setSaving(true);
    setError(null);
    try {
      onScriptUpdated(await persistScript(jobId, next));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium text-[color:var(--ink)]">
          {videoSlot ? slotLabel(videoSlot) : "What you say"}
        </p>
        <LineKind kind="spoken" />
        {filled && (
          <span className="text-[11px] font-medium text-emerald-600">
            {saving ? "Saving…" : "Saved"}
          </span>
        )}
      </div>
      {!filled && (
        <p className="text-[12px] leading-snug text-[color:var(--ink-dim)]">
          {videoSlot?.instructions ?? "What you say on camera for this beat."}
        </p>
      )}
      <textarea
        defaultValue={text}
        placeholder={videoSlot?.example ? `e.g. ${videoSlot.example}` : undefined}
        onChange={(e) => onDraftChange(e.target.value)}
        onBlur={(e) => {
          const value = e.target.value;
          if (value !== text) save(value);
        }}
        rows={2}
        className="w-full resize-none rounded-lg border border-[color:var(--card-border)] bg-[color:var(--bg-2)] p-3 text-sm text-[color:var(--ink)] outline-none placeholder:text-[color:var(--ink-dim)] focus:border-[color:var(--accent)]"
      />
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}

/** One storyboard card per block in Step 1: the spoken line (if this block
 *  is a voice beat) and the block's other on-screen text fields on the
 *  left, a live phone-frame preview of how they'll actually look on the
 *  right — so "what you say vs what's on screen" is something you can see,
 *  not something you have to infer from a variable name. Owns a `drafts`
 *  mirror of every field's in-progress value (fed by SlotDropzone's
 *  onDraftChange and SpokenLineField's onDraftChange) purely so the preview
 *  can update per keystroke; saving still goes through each field's own
 *  blur handler unchanged. */
export function ScriptingBlockCard({
  jobId,
  format,
  block,
  index,
  bindings,
  onChange,
  suggestionFor,
  onApplySuggestion,
  hasSpokenLine,
  script,
  onScriptUpdated,
}: {
  jobId: string;
  format: Format;
  block: Block;
  /** Display position among the blocks actually shown in Step 1 (not the
   *  block's raw index in format.blocks, which also includes blocks with
   *  nothing to write at all). */
  index: number;
  bindings: Record<string, Binding | undefined>;
  onChange: (slotName: string, binding: Binding | undefined) => void;
  suggestionFor: (slotName: string) => ScriptSuggestion["suggestions"][number] | undefined;
  onApplySuggestion: (slotName: string, text: string) => void;
  /** True for a non-optional voice block — this block has a line the
   *  creator says on camera, shown first among its fields. */
  hasSpokenLine: boolean;
  script: ScriptSuggestion | null;
  onScriptUpdated: (script: ScriptSuggestion) => void;
}) {
  const textSlots = block.slots.filter((s) => s.mediaType === "text");
  const videoSlot = block.slots.find((s) => s.name === block.videoSlot);

  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const slot of textSlots) {
      const binding = bindings[slot.name];
      initial[slot.name] = binding && "text" in binding ? binding.text : "";
    }
    if (hasSpokenLine) {
      initial.__spokenLine =
        script?.suggestions.find(
          (s) => s.blockId === block.id && s.slotName === block.videoSlot,
        )?.text ?? "";
    }
    return initial;
  });

  const requiredSlots = textSlots.filter((s) => s.required);
  const filledCount =
    requiredSlots.filter((s) => {
      const binding = bindings[s.name];
      return !!binding && "text" in binding && binding.text.trim().length > 0;
    }).length + (hasSpokenLine && drafts.__spokenLine?.trim() ? 1 : 0);
  const totalRequired = requiredSlots.length + (hasSpokenLine ? 1 : 0);
  const allDone = totalRequired > 0 && filledCount === totalRequired;

  return (
    <Card className="p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color:var(--accent)] text-xs font-bold text-[color:var(--accent-ink)]">
          {index}
        </span>
        <h2 className="font-[family-name:var(--font-display)] text-lg font-bold text-[color:var(--ink)]">
          {block.title}
        </h2>
        {block.brollDurationSec && <Pill>~{block.brollDurationSec.toFixed(1)}s on screen</Pill>}
        {totalRequired > 0 && (
          <span
            className={`ml-auto text-[11px] font-medium ${allDone ? "text-emerald-600" : "text-[color:var(--ink-dim)]"}`}
          >
            {allDone ? "✓ Done" : `${filledCount} of ${totalRequired} filled`}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="grid flex-1 grid-cols-1 gap-6 sm:grid-cols-2">
          {hasSpokenLine && (
            <div className="sm:col-span-2">
              <SpokenLineField
                jobId={jobId}
                block={block}
                videoSlot={videoSlot}
                script={script}
                onScriptUpdated={onScriptUpdated}
                onDraftChange={(value) =>
                  setDrafts((prev) => ({ ...prev, __spokenLine: value }))
                }
              />
            </div>
          )}
          {textSlots.map((slot) => {
            const suggestion = suggestionFor(slot.name);
            return (
              <div key={slot.name} className="flex flex-col gap-2">
                {suggestion && (
                  <div className="rounded-lg border border-dashed border-[color:var(--accent)]/40 bg-[color:var(--accent)]/5 p-3">
                    <p className="mb-1 text-[11px] tracking-wide text-[color:var(--accent)] uppercase">Suggested</p>
                    <p className="text-sm text-[color:var(--ink-dim)] italic">&ldquo;{suggestion.text}&rdquo;</p>
                    <button
                      onClick={() => {
                        onApplySuggestion(slot.name, suggestion.text);
                        setDrafts((prev) => ({ ...prev, [slot.name]: suggestion.text }));
                      }}
                      className="mt-1 text-xs font-medium text-[color:var(--accent)]"
                    >
                      Use this
                    </button>
                  </div>
                )}
                <SlotDropzone
                  jobId={jobId}
                  formatId={format.id}
                  slot={slot}
                  binding={bindings[slot.name]}
                  siblingBindings={bindings}
                  onChange={onChange}
                  onDraftChange={(name, value) => setDrafts((prev) => ({ ...prev, [name]: value }))}
                />
              </div>
            );
          })}
        </div>
        <BlockTextPreview format={format} block={block} values={drafts} />
      </div>
    </Card>
  );
}

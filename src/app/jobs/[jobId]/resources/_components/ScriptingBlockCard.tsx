"use client";

import { useState } from "react";
import type { Block, Format } from "@backend/pipeline/types";
import type { ScriptSuggestion } from "@backend/content/types";
import { Card, Pill } from "../../../../_components/ui";
import { Binding, SlotDropzone } from "./SlotDropzone";
import { BlockTextPreview } from "./BlockTextPreview";

/** One storyboard card per block in Step 1: the block's text fields on the
 *  left, a live phone-frame preview of how they'll actually look on the
 *  right — so "title vs description vs resolve" is something you can see,
 *  not something you have to infer from a variable name. Owns a `drafts`
 *  mirror of the text slots' in-progress values (fed by SlotDropzone's
 *  onDraftChange) purely so the preview can update per keystroke; saving
 *  still goes through SlotDropzone's own onBlur -> bindText flow unchanged. */
export function ScriptingBlockCard({
  jobId,
  format,
  block,
  index,
  bindings,
  onChange,
  suggestionFor,
  onApplySuggestion,
}: {
  jobId: string;
  format: Format;
  block: Block;
  /** Display position among the blocks actually shown in Step 1 (not the
   *  block's raw index in format.blocks, which also includes blocks with
   *  no text slots at all). */
  index: number;
  bindings: Record<string, Binding | undefined>;
  onChange: (slotName: string, binding: Binding | undefined) => void;
  suggestionFor: (slotName: string) => ScriptSuggestion["suggestions"][number] | undefined;
  onApplySuggestion: (slotName: string, text: string) => void;
}) {
  const textSlots = block.slots.filter((s) => s.mediaType === "text");

  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const slot of textSlots) {
      const binding = bindings[slot.name];
      initial[slot.name] = binding && "text" in binding ? binding.text : "";
    }
    return initial;
  });

  const requiredSlots = textSlots.filter((s) => s.required);
  const filledCount = requiredSlots.filter((s) => {
    const binding = bindings[s.name];
    return !!binding && "text" in binding && binding.text.trim().length > 0;
  }).length;
  const allDone = requiredSlots.length > 0 && filledCount === requiredSlots.length;

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
        {requiredSlots.length > 0 && (
          <span
            className={`ml-auto text-[11px] font-medium ${allDone ? "text-emerald-400" : "text-[color:var(--ink-dim)]"}`}
          >
            {allDone ? "✓ Done" : `${filledCount} of ${requiredSlots.length} filled`}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="grid flex-1 grid-cols-1 gap-6 sm:grid-cols-2">
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

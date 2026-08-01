"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Format, Slot } from "@backend/pipeline/types";
import type { HookFeedbackResult, ScriptSuggestion } from "@backend/content/types";
import { Button, Card, Pill } from "../../../../_components/ui";
import { LibraryPanel } from "../../../../_components/library/LibraryPanel";
import { Binding, SlotDropzone, bindText } from "./SlotDropzone";
import { ScriptPanel } from "./ScriptPanel";
import { ScriptLines } from "./ScriptLines";
import { IdentityPhotoGrid } from "./IdentityPhotoGrid";
import { SplitLines } from "./SplitLines";
import { HookFeedbackPanel } from "./HookFeedbackPanel";
import { WizardFooterNav, WizardHeader, WizardStepInfo } from "./WizardNav";

/** Every slot the format declares: block, shared, music, identity,
 *  speaking-take, and final-clip slots — same shape allSlots() computes
 *  server-side. */
const allSlots = (format: Format): Slot[] => [
  ...format.blocks.flatMap((b) => b.slots),
  ...format.sharedSlots,
  ...(format.musicSlot ? [format.musicSlot] : []),
  ...(format.identitySlot ? [format.identitySlot] : []),
  ...(format.speakingTakeSlot ? [format.speakingTakeSlot] : []),
  ...(format.finalClipSlot ? [format.finalClipSlot] : []),
];

/** Three steps, matching the flow this was modeled on: write your lines,
 *  upload footage/photos/optional extras, then (for a single-take format)
 *  split the take into lines before building. A format without
 *  speakingTakeSlot just skips straight from footage to review+build in
 *  Step 3 — same step count either way. */
const STEPS: WizardStepInfo[] = [
  { id: 1, label: "Write your lines", kicker: "Scripting & planning" },
  { id: 2, label: "Add your footage & photos", kicker: "Upload & inputs" },
  { id: 3, label: "Split your take & build", kicker: "Preparation" },
];

export function ResourcesBoard({
  jobId,
  format,
  initialBindings,
  initialScript = null,
  initialHookFeedback = null,
}: {
  jobId: string;
  format: Format;
  initialBindings: Record<string, Binding>;
  initialScript?: ScriptSuggestion | null;
  initialHookFeedback?: HookFeedbackResult | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const stepParam = Number(searchParams.get("step"));
  const step = STEPS.some((s) => s.id === stepParam) ? stepParam : 1;

  const goToStep = (next: number) => router.replace(`${pathname}?step=${next}`, { scroll: false });

  const [bindings, setBindings] = useState<Record<string, Binding | undefined>>(initialBindings);
  const [script, setScript] = useState<ScriptSuggestion | null>(initialScript);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  /** What assemble() skipped/altered from the format's declared structure
   *  (unfilled slot, unmatched anchor, a beat sequence that didn't fit its
   *  runway, a duplicate sfx collapsed to one) — shown here instead of only
   *  a server console.warn, since this is the moment the user can actually
   *  do something about it (fill a slot, re-film a take). */
  const [diagnostics, setDiagnostics] = useState<string[] | null>(null);

  // In single-take mode, a voice block's own clip slot is DERIVED from
  // speakingTakeSlot at intake time (see intake.ts) — never an upload
  // target here, same treatment as a generated slot but for a different
  // reason. Both this set and the `.generation` check below exist so
  // "required slots filled" and the Step 2 dropzone grid agree on what's
  // actually user-fillable.
  const derivedFromTake = useMemo(
    () =>
      new Set(
        format.speakingTakeSlot
          ? format.blocks.filter((b) => b.kind === "voice").map((b) => b.videoSlot)
          : [],
      ),
    [format],
  );

  const requiredSlots = useMemo(
    () =>
      allSlots(format).filter((s) => s.required && !s.generation && !derivedFromTake.has(s.name)),
    [format, derivedFromTake],
  );
  const filledCount = requiredSlots.filter((s) => bindings[s.name]).length;
  const ready = filledCount === requiredSlots.length;
  /** "The hook" = the first voice block, true across every format so far
   *  without hardcoding an id string — see content/virality.ts. */
  const hookBlock = useMemo(() => format.blocks.find((b) => b.kind === "voice"), [format]);

  const speakingTakeBinding = format.speakingTakeSlot ? bindings[format.speakingTakeSlot.name] : undefined;
  const speakingTakeFile =
    speakingTakeBinding && "file" in speakingTakeBinding ? speakingTakeBinding.file : undefined;

  const setBinding = (slotName: string, binding: Binding | undefined) => {
    setBindings((prev) => ({ ...prev, [slotName]: binding }));
  };

  const applySuggestion = async (slotName: string, text: string) => {
    setBinding(slotName, await bindText(jobId, slotName, text));
  };

  const continueToEditor = async (opts: { force?: boolean } = {}) => {
    setBuilding(true);
    setBuildError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "build failed");
      const buildDiagnostics: string[] = data.edl?.diagnostics ?? [];
      if (buildDiagnostics.length > 0 && !opts.force) {
        setDiagnostics(buildDiagnostics);
        setBuilding(false);
        return;
      }
      router.push(`/jobs/${jobId}/edit`);
    } catch (err) {
      setBuildError((err as Error).message);
      setBuilding(false);
    }
  };

  const suggestionFor = (blockId: string, slotName: string) =>
    script?.suggestions.find((s) => s.blockId === blockId && s.slotName === slotName);

  /** A generation-marked slot is never an upload target — shown as a badge
   *  explaining why, instead of an actionable (and permanently-empty)
   *  dropzone (see requiredSlots above for the matching "don't count it"
   *  half of this). */
  const generatedSlotBadge = (slot: Slot) => (
    <div key={slot.name} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--accent)]" />
        <p className="text-sm font-medium text-[color:var(--ink)]">{slot.name}</p>
        <Pill>auto-generated</Pill>
      </div>
      <p className="text-[12px] leading-snug text-[color:var(--ink-dim)]">
        Generated automatically from your identity photos when you build — nothing to upload here.{" "}
        {slot.instructions}
      </p>
    </div>
  );

  return (
    <div className="grid grid-cols-1 gap-8 xl:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-6">
        <WizardHeader steps={STEPS} current={step} onSelect={goToStep} />

        {step === 1 && (
          <>
            <ScriptPanel jobId={jobId} script={script} onScriptUpdated={setScript} />
            <ScriptLines jobId={jobId} format={format} script={script} onScriptUpdated={setScript} />
            {format.blocks.map((block) => {
              const textSlots = block.slots.filter((s) => s.mediaType === "text");
              if (textSlots.length === 0) return null;
              return (
                <Card key={block.id} className="p-6">
                  <div className="mb-4 flex items-center gap-2">
                    <h2 className="font-[family-name:var(--font-display)] text-lg font-bold text-[color:var(--ink)]">
                      {block.title}
                    </h2>
                    <Pill>{block.kind === "voice" ? "spoken" : "b-roll"}</Pill>
                  </div>
                  <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                    {textSlots.map((slot) => {
                      const suggestion = suggestionFor(block.id, slot.name);
                      return (
                        <div key={slot.name} className="flex flex-col gap-2">
                          {suggestion && (
                            <div className="rounded-lg border border-dashed border-[color:var(--accent)]/40 bg-[color:var(--accent)]/5 p-3">
                              <p className="mb-1 text-[11px] tracking-wide text-[color:var(--accent)] uppercase">
                                Suggested
                              </p>
                              <p className="text-sm text-[color:var(--ink-dim)] italic">
                                &ldquo;{suggestion.text}&rdquo;
                              </p>
                              <button
                                onClick={() => applySuggestion(slot.name, suggestion.text)}
                                className="mt-1 text-xs font-medium text-[color:var(--accent)]"
                              >
                                Use this
                              </button>
                            </div>
                          )}
                          <SlotDropzone
                            jobId={jobId}
                            slot={slot}
                            binding={bindings[slot.name]}
                            onChange={setBinding}
                          />
                        </div>
                      );
                    })}
                  </div>
                </Card>
              );
            })}
          </>
        )}

        {step === 2 && (
          <>
            {format.speakingTakeSlot && (
              <Card className="p-6">
                <div className="mb-4 flex items-center gap-2">
                  <h2 className="font-[family-name:var(--font-display)] text-lg font-bold text-[color:var(--ink)]">
                    Speaking take
                  </h2>
                  <Pill>one continuous take of all your lines</Pill>
                </div>
                <div className="max-w-md">
                  <SlotDropzone
                    jobId={jobId}
                    slot={format.speakingTakeSlot}
                    binding={bindings[format.speakingTakeSlot.name]}
                    onChange={setBinding}
                  />
                </div>
              </Card>
            )}

            {format.blocks.map((block) => {
              const footageSlots = block.slots.filter(
                (s) => s.mediaType !== "text" && !derivedFromTake.has(s.name),
              );
              if (footageSlots.length === 0) return null;
              return (
                <Card key={block.id} className="p-6">
                  <div className="mb-4 flex items-center gap-2">
                    <h2 className="font-[family-name:var(--font-display)] text-lg font-bold text-[color:var(--ink)]">
                      {block.title}
                    </h2>
                    <Pill>{block.kind === "voice" ? "spoken" : "b-roll"}</Pill>
                  </div>
                  <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                    {footageSlots.map((slot) =>
                      slot.generation ? (
                        generatedSlotBadge(slot)
                      ) : (
                        <SlotDropzone
                          key={slot.name}
                          jobId={jobId}
                          slot={slot}
                          binding={bindings[slot.name]}
                          onChange={setBinding}
                          multi={block.kind === "voice" && slot.name === block.videoSlot}
                        />
                      ),
                    )}
                  </div>
                </Card>
              );
            })}

            {format.identitySlot && (
              <IdentityPhotoGrid
                jobId={jobId}
                slot={format.identitySlot}
                binding={bindings[format.identitySlot.name]}
                onChange={setBinding}
              />
            )}

            {format.finalClipSlot && (
              <Card className="p-6">
                <div className="mb-4 flex items-center gap-2">
                  <h2 className="font-[family-name:var(--font-display)] text-lg font-bold text-[color:var(--ink)]">
                    Final clip
                  </h2>
                  <Pill>optional</Pill>
                </div>
                <div className="max-w-sm">
                  <SlotDropzone
                    jobId={jobId}
                    slot={format.finalClipSlot}
                    binding={bindings[format.finalClipSlot.name]}
                    onChange={setBinding}
                  />
                </div>
              </Card>
            )}

            {format.sharedSlots.length > 0 && (
              <Card className="p-6">
                <div className="mb-4 flex items-center gap-2">
                  <h2 className="font-[family-name:var(--font-display)] text-lg font-bold text-[color:var(--ink)]">
                    Shared sounds
                  </h2>
                  <Pill>used across blocks</Pill>
                </div>
                <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                  {format.sharedSlots.map((slot) => (
                    <SlotDropzone
                      key={slot.name}
                      jobId={jobId}
                      slot={slot}
                      binding={bindings[slot.name]}
                      onChange={setBinding}
                    />
                  ))}
                </div>
              </Card>
            )}

            {format.musicSlot && (
              <Card className="p-6">
                <h2 className="mb-4 font-[family-name:var(--font-display)] text-lg font-bold text-[color:var(--ink)]">
                  Music
                </h2>
                <div className="max-w-sm">
                  <SlotDropzone
                    jobId={jobId}
                    slot={format.musicSlot}
                    binding={bindings[format.musicSlot.name]}
                    onChange={setBinding}
                  />
                </div>
              </Card>
            )}
          </>
        )}

        {step === 3 && (
          <>
            {format.speakingTakeSlot && (
              <SplitLines jobId={jobId} format={format} script={script} takeFile={speakingTakeFile} />
            )}

            {hookBlock && <HookFeedbackPanel jobId={jobId} initialFeedback={initialHookFeedback} />}

            {diagnostics && diagnostics.length > 0 && (
              <div className="rounded-2xl border border-amber-400/30 bg-amber-400/10 p-5 backdrop-blur-md">
                <p className="mb-2 text-sm font-medium text-amber-300">
                  The build skipped {diagnostics.length} {diagnostics.length === 1 ? "thing" : "things"} —
                  worth a look before you edit:
                </p>
                <ul className="mb-3 list-disc space-y-1 pl-5 text-xs text-amber-200/90">
                  {diagnostics.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => setDiagnostics(null)} className="!px-4 !py-2 text-xs">
                    Fix and rebuild
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => continueToEditor({ force: true })}
                    className="!px-4 !py-2 text-xs"
                  >
                    Continue to editor anyway
                  </Button>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-[color:var(--bg)]/90 p-5 backdrop-blur-md">
              <div>
                <p className="text-sm text-[color:var(--ink)]">
                  {filledCount} / {requiredSlots.length} required slots filled
                </p>
                {!ready && (
                  <p className="text-xs text-[color:var(--ink-dim)]">
                    Missing something? Go back to Script or Footage & photos to finish filling slots.
                  </p>
                )}
                {buildError && <p className="text-xs text-red-400">{buildError}</p>}
              </div>
              {/* Once the diagnostics panel is already on screen the warnings
                  have been seen, so this proceeds instead of rebuilding into
                  the same early-return — otherwise the primary CTA looks
                  broken: it spins, re-lists the same skips, and never
                  navigates. "Fix and rebuild" clears them to re-arm it. */}
              <Button
                onClick={() => continueToEditor({ force: diagnostics !== null })}
                disabled={!ready || building}
              >
                {building ? "Building…" : diagnostics ? "Continue anyway" : "Continue to editor"}
              </Button>
            </div>
          </>
        )}

        <WizardFooterNav current={step} total={STEPS.length} onBack={() => goToStep(step - 1)} onNext={() => goToStep(step + 1)} />
      </div>

      <div className={`xl:sticky xl:top-24 xl:h-[calc(100vh-140px)] ${drawerOpen ? "" : "xl:h-auto"}`}>
        <div className="mb-2 flex items-center justify-between xl:hidden">
          <p className="font-[family-name:var(--font-display)] text-sm text-[color:var(--ink-dim)]">Library</p>
          <button onClick={() => setDrawerOpen((v) => !v)} className="text-xs text-[color:var(--accent)]">
            {drawerOpen ? "Hide" : "Show"}
          </button>
        </div>
        {drawerOpen && (
          <div className="h-[520px] overflow-hidden rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] xl:h-full">
            <LibraryPanel variant="drawer" />
          </div>
        )}
      </div>
    </div>
  );
}

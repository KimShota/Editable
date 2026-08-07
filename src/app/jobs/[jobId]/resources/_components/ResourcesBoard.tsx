"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Edl, Format, Slot } from "@backend/pipeline/types";
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
 *  upload footage/photos/optional extras, then (when this job actually
 *  bound a speaking take) split it into lines before building. A job that
 *  filmed every block's own clip individually — or a format with no
 *  speakingTakeSlot at all — just skips straight from footage to
 *  review+build in Step 3, same step count either way. */
const STEPS: WizardStepInfo[] = [
  { id: 1, label: "Scripting", kicker: "Scripting & planning" },
  { id: 2, label: "Filming", kicker: "Upload & inputs" },
  { id: 3, label: "Split your take & build", kicker: "Preparation" },
];

/** Mirrors the build API route's status shape (build/route.ts) — the build
 *  runs as a background subprocess (paid generation + whisper/ffmpeg can
 *  take minutes), so this is polled rather than awaited from one fetch. */
type BuildStatus =
  | { status: "idle" }
  | { status: "building"; startedAt: string; stage: string }
  | { status: "done"; startedAt: string; finishedAt: string; edl: Edl }
  | { status: "error"; startedAt: string; finishedAt: string; error: string };

const BUILD_POLL_MS = 2000;

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
  const [buildStage, setBuildStage] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  /** What assemble() skipped/altered from the format's declared structure
   *  (unfilled slot, unmatched anchor, a beat sequence that didn't fit its
   *  runway, a duplicate sfx collapsed to one) — shown here instead of only
   *  a server console.warn, since this is the moment the user can actually
   *  do something about it (fill a slot, re-film a take). */
  const [diagnostics, setDiagnostics] = useState<string[] | null>(null);

  const takeSlot = format.speakingTakeSlot;
  // A format's speakingTakeSlot is either the MANDATORY, sole way to
  // supply voice footage (e.g. cinematic-debut-manifesto, `required:
  // true`) or an OPTIONAL alternative to per-block uploads (every format
  // loader.ts auto-synthesizes one for — see withImplicitSpeakingTake).
  // The two need different UI: a mandatory take hides every voice block's
  // own clip dropzone outright (it's never a real upload target); an
  // optional one keeps every dropzone visible so per-clip filming keeps
  // working unchanged, and only marks a block as "covered" once a take is
  // actually dropped in — see takeCoveredSlots below.
  const takeRequired = !!takeSlot?.required;
  const takeBinding = takeSlot ? bindings[takeSlot.name] : undefined;
  const takeIsBound = !!takeBinding;

  const alwaysHiddenSlots = useMemo(
    () =>
      new Set(
        takeSlot && takeRequired
          ? format.blocks.filter((b) => b.kind === "voice" && !b.optional).map((b) => b.videoSlot)
          : [],
      ),
    [format, takeSlot, takeRequired],
  );

  // Mirrors intake.ts's own derivedFromTake-when-takeBound: once an
  // OPTIONAL take is actually dropped in, every voice block the user
  // hasn't individually bound is covered by it instead — so its own
  // dropzone stops counting as required (and gets an explanatory note,
  // rendered below) without disappearing outright, which is what lets a
  // block still be re-filmed on its own to override the take for just
  // that line.
  const takeCoveredSlots = useMemo(
    () =>
      new Set(
        takeSlot && !takeRequired && takeIsBound
          ? format.blocks
              .filter((b) => b.kind === "voice" && !b.optional && !bindings[b.videoSlot])
              .map((b) => b.videoSlot)
          : [],
      ),
    [format, takeSlot, takeRequired, takeIsBound, bindings],
  );

  const requiredSlots = useMemo(
    () =>
      allSlots(format).filter(
        (s) => s.required && !s.generation && !alwaysHiddenSlots.has(s.name) && !takeCoveredSlots.has(s.name),
      ),
    [format, alwaysHiddenSlots, takeCoveredSlots],
  );
  const filledCount = requiredSlots.filter((s) => bindings[s.name]).length;
  const ready = filledCount === requiredSlots.length;
  /** "The hook" = the first voice block, true across every format so far
   *  without hardcoding an id string — see content/virality.ts. */
  const hookBlock = useMemo(() => format.blocks.find((b) => b.kind === "voice"), [format]);

  const speakingTakeFile = takeBinding && "file" in takeBinding ? takeBinding.file : undefined;

  const setBinding = (slotName: string, binding: Binding | undefined) => {
    setBindings((prev) => ({ ...prev, [slotName]: binding }));
  };

  const applySuggestion = async (slotName: string, text: string) => {
    setBinding(slotName, await bindText(jobId, slotName, text));
  };

  // Set by continueToEditor each time it's called, read once the build this
  // click started finishes — a ref (not state) because the poll interval
  // that eventually reads it is a closure captured at start-polling time,
  // not re-created per click.
  const forceRef = useRef(false);
  const buildTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopBuildPolling = () => {
    if (buildTimer.current) {
      clearInterval(buildTimer.current);
      buildTimer.current = null;
    }
  };

  const handleBuildStatus = (data: BuildStatus) => {
    if (data.status === "building") {
      setBuilding(true);
      setBuildStage(data.stage);
      return;
    }
    stopBuildPolling();
    setBuilding(false);
    if (data.status === "error") {
      setBuildError(data.error);
    } else if (data.status === "done") {
      const buildDiagnostics: string[] = data.edl.diagnostics ?? [];
      if (buildDiagnostics.length > 0 && !forceRef.current) {
        setDiagnostics(buildDiagnostics);
        return;
      }
      router.push(`/jobs/${jobId}/edit`);
    }
  };

  const pollBuildStatus = async () => {
    const res = await fetch(`/api/jobs/${jobId}/build`);
    handleBuildStatus(await res.json());
  };

  // A build already in flight (kicked off before a refresh, or from another
  // tab) survives the subprocess even though this component just remounted
  // — pick its polling back up instead of leaving the button showing
  // "Continue to editor" over a build that's still actually running. A
  // "done"/"error" status file is left on disk indefinitely (until the next
  // build overwrites it), so ignore anything but "building" here — otherwise
  // simply opening this page later would replay a stale past result,
  // including auto-navigating to /edit from a long-finished build.
  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/jobs/${jobId}/build`);
      const data: BuildStatus = await res.json();
      if (data.status === "building") {
        setBuilding(true);
        setBuildStage(data.stage);
        buildTimer.current = setInterval(pollBuildStatus, BUILD_POLL_MS);
      }
    })();
    return stopBuildPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const continueToEditor = async (opts: { force?: boolean } = {}) => {
    forceRef.current = !!opts.force;
    setBuilding(true);
    setBuildStage(null);
    setBuildError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "build failed");
      if (!buildTimer.current) buildTimer.current = setInterval(pollBuildStatus, BUILD_POLL_MS);
      handleBuildStatus(data);
    } catch (err) {
      setBuilding(false);
      setBuildError((err as Error).message);
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
            {hookBlock && (
              <ScriptLines jobId={jobId} format={format} script={script} onScriptUpdated={setScript} />
            )}
            {format.blocks.map((block) => {
              const textSlots = block.slots.filter((s) => s.mediaType === "text");
              if (textSlots.length === 0) return null;
              return (
                <Card key={block.id} className="p-6">
                  <div className="mb-4 flex items-center gap-2">
                    <h2 className="font-[family-name:var(--font-display)] text-lg font-bold text-[color:var(--ink)]">
                      {block.title} — on-screen text
                    </h2>
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
                            formatId={format.id}
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
            {takeSlot && (
              <Card className="p-6">
                <div className="mb-4 flex items-center gap-2">
                  <h2 className="font-[family-name:var(--font-display)] text-lg font-bold text-[color:var(--ink)]">
                    Speaking take
                  </h2>
                  <Pill>
                    {takeRequired
                      ? "one continuous take of all your lines"
                      : "optional — film it all in one take instead"}
                  </Pill>
                </div>
                {!takeRequired && (
                  <p className="mb-4 text-[12px] leading-snug text-[color:var(--ink-dim)]">
                    Filmed each line separately? Skip this and fill in each block&apos;s own clip below
                    instead. Throw in one whole take here and we&apos;ll automatically find where each
                    line starts — you can even mix the two, using this for most of it and re-filming a
                    line or two on its own below. Didn&apos;t film it in one go? Drop in several clips —
                    even a clip that only covers one word — and we&apos;ll figure out what&apos;s said in
                    each, put them in order, and stitch them into one continuous take.
                  </p>
                )}
                <div className="max-w-md">
                  <SlotDropzone
                    jobId={jobId}
                    formatId={format.id}
                    slot={takeSlot}
                    binding={bindings[takeSlot.name]}
                    onChange={setBinding}
                    multi
                  />
                </div>
              </Card>
            )}

            {format.blocks.map((block) => {
              const footageSlots = block.slots.filter(
                (s) => s.mediaType !== "text" && !alwaysHiddenSlots.has(s.name),
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
                          formatId={format.id}
                          slot={slot}
                          binding={bindings[slot.name]}
                          onChange={setBinding}
                          multi={block.kind === "voice" && slot.name === block.videoSlot}
                          coveredNote={
                            takeCoveredSlots.has(slot.name)
                              ? "Covered by your speaking take — drop a clip here to film this line separately instead."
                              : undefined
                          }
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
                    formatId={format.id}
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
                      formatId={format.id}
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
                    formatId={format.id}
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
            {/* A mandatory take (takeRequired) always shows this, even before
                it's bound, matching cinematic-debut-manifesto's existing
                "upload it in the previous step first" nudge. An OPTIONAL take
                only shows once actually bound — no reason to nudge a
                per-clip-only user toward a step that has nothing to do. */}
            {takeSlot && (takeRequired || takeIsBound) && (
              <SplitLines
                jobId={jobId}
                format={format}
                script={script}
                takeFile={speakingTakeFile}
                takeBound={takeRequired || takeIsBound}
              />
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
                {building ? `Building…${buildStage ? ` (${buildStage})` : ""}` : diagnostics ? "Continue anyway" : "Continue to editor"}
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

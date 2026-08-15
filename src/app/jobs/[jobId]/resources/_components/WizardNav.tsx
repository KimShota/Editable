"use client";

import { Button } from "../../../../_components/ui";

export type WizardStepInfo = {
  id: number;
  label: string;
  kicker: string;
  /** One plain-language sentence explaining what to do on this step —
   *  shown under the step title so the wizard tells you what it wants
   *  instead of you inferring it from the fields alone. */
  description?: string;
};

/**
 * Step header + clickable progress bar + Back/Next footer for the
 * resources wizard. Steps stay freely reachable by clicking a segment —
 * same "make changes here until you generate" freedom the single-page
 * board already had — with one exception the caller enforces, not this
 * component: ResourcesBoard's attemptGoToStep blocks reaching step 3
 * until step 2's required footage/photos are filled, so `onSelect`/
 * `onNext` here may decline to navigate and surface an error instead.
 */
export function WizardHeader({
  steps,
  current,
  onSelect,
}: {
  steps: WizardStepInfo[];
  current: number;
  onSelect: (step: number) => void;
}) {
  const step = steps.find((s) => s.id === current) ?? steps[0];
  return (
    <div className="mb-8 overflow-hidden rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)]">
      <div className="flex flex-wrap items-center justify-between gap-2 px-6 pt-6">
        <p className="font-[family-name:var(--font-display)] text-xs tracking-[0.2em] text-[color:var(--accent)] uppercase">
          Step {step.id} of {steps.length}
        </p>
        <p className="text-xs text-[color:var(--ink-dim)]">{step.kicker}</p>
      </div>
      <h2 className="px-6 pt-2 font-[family-name:var(--font-display)] text-2xl font-bold text-[color:var(--ink)]">
        {step.label}
      </h2>
      {step.description && (
        <p className="px-6 pt-2 text-sm text-[color:var(--ink-dim)]">{step.description}</p>
      )}
      <div className="flex gap-1.5 px-6 pt-5 pb-6">
        {steps.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            title={s.label}
            aria-label={`Go to step ${s.id}: ${s.label}`}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              s.id <= current ? "bg-[color:var(--accent)]" : "bg-white/10 hover:bg-white/20"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

export function WizardFooterNav({
  current,
  total,
  onBack,
  onNext,
}: {
  current: number;
  total: number;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex items-center justify-between border-t border-white/10 pt-6">
      <Button variant="secondary" onClick={onBack} disabled={current === 1}>
        Back
      </Button>
      <Button onClick={onNext} disabled={current === total}>
        Next
      </Button>
    </div>
  );
}

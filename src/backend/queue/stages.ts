/**
 * One bar across the stages of a long job. A job reports its stage by name
 * and, inside the "clips" stage, how many shots are done; the browser turns
 * that into a single percentage and a step track. Pure, so the same numbers
 * are checked on the server and drawn in the browser.
 */

export type StageSpec = {
  /** Part of the stage name the job reports (case-insensitive). */
  match: string;
  /** What the step track says. */
  label: string;
  /** Roughly how much of the whole job this stage is. Only the ratios matter. */
  weight: number;
};

export type StepState = "done" | "current" | "upcoming";
export type StageView = { percent: number; steps: { label: string; state: StepState }[] };

/** The names `video.produce` reports (jobs/productionCli.ts, jobs/stubProduction.ts). */
export const PRODUCE_STAGE = {
  voice: "Voicing the script",
  clips: "Making the clips",
  assemble: "Putting the video together",
} as const;

/** Producing a video: the voice takes seconds, the paid clips take most of the time, the render under a minute. */
export const PRODUCTION_STAGES: StageSpec[] = [
  { match: PRODUCE_STAGE.voice, label: "Voice", weight: 5 },
  { match: PRODUCE_STAGE.clips, label: "Clips", weight: 80 },
  { match: PRODUCE_STAGE.assemble, label: "Finishing", weight: 15 },
];

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Where a job is, or null when its stage is not one of `specs` (the caller then draws its own bar). */
export const stageProgress = (specs: StageSpec[], stage: string | null, done: number | null, total: number | null): StageView | null => {
  if (!stage || specs.length === 0) return null;
  const at = stage.toLowerCase();
  const index = specs.findIndex((s) => at.includes(s.match.toLowerCase()));
  if (index === -1) return null;
  const sum = specs.reduce((n, s) => n + s.weight, 0);
  const before = specs.slice(0, index).reduce((n, s) => n + s.weight, 0);
  const within = total !== null && total > 0 && done !== null ? clamp01(done / total) : 0;
  return {
    percent: Math.round(((before + specs[index].weight * within) / sum) * 100),
    steps: specs.map((s, i) => ({ label: s.label, state: i < index ? "done" : i === index ? "current" : "upcoming" })),
  };
};

/** Every step ticked off, for a job that has finished. */
export const finishedStages = (specs: StageSpec[]): StageView => ({ percent: 100, steps: specs.map((s) => ({ label: s.label, state: "done" as const })) });

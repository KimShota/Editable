"use client";

import { useState } from "react";
import { type ReplayStep, TaskProgress } from "../../../_components/TaskProgress";

const REPLAY_STEPS: ReplayStep[] = [
  { stage: "Reading your site", message: "fetching pages" },
  { stage: "Finding your product", message: "3 candidates" },
  { stage: "Drafting your brand kit" },
  { stage: "Done reading" },
];
// A stable object: TaskProgress restarts its replay when this identity's
// duration/length changes, so it must not be rebuilt on every render.
const REPLAY = { steps: REPLAY_STEPS, durationMs: 1600 };

export function TaskProgressDemo({ taskId, replay }: { taskId?: number; replay: boolean }) {
  const [finished, setFinished] = useState(0);
  const [retries, setRetries] = useState(0);
  return (
    <div className="flex max-w-xl flex-col gap-4">
      <TaskProgress
        taskId={taskId}
        replay={replay ? REPLAY : undefined}
        title="Generating storyboard"
        onDone={() => setFinished((n) => n + 1)}
        onRetry={() => setRetries((n) => n + 1)}
        pollMs={400}
      />
      <p data-testid="finished-count" className="text-sm text-[color:var(--ink-dim)]">
        finished callbacks: {finished}
      </p>
      <p data-testid="retry-count" className="text-sm text-[color:var(--ink-dim)]">
        retries: {retries}
      </p>
    </div>
  );
}

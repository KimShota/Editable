import type { TaskProgress, TaskStatus, TaskView } from "@backend/queue/workQueue";

/** A task as the browser sees it. The payload and result stay server-side
 *  (they can hold prompts and costs), and a customer gets a plain message
 *  instead of a stack trace. */
export type PublicTask = {
  id: number;
  kind: string;
  status: TaskStatus;
  progress: TaskProgress | null;
  error: string | null;
  finishedAt: string | null;
};

export const toPublicTask = (task: TaskView, isAdmin: boolean): PublicTask => ({
  id: task.id,
  kind: task.kind,
  status: task.status,
  progress: task.progress,
  error: task.error === null ? null : isAdmin ? task.error : "This step did not finish. We have been notified and will look at it.",
  finishedAt: task.finishedAt,
});

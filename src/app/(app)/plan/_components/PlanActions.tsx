"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { sendJson } from "../../../lib/clientApi";
import { TaskProgress } from "../../../_components/TaskProgress";
import { Button } from "../../../_components/ui";

type ApproveAllResult = { approved: string[]; skipped: { cardId: string; reason: string }[] };

/** Approves every draft that is ready. Says what it skipped and why, so
 *  "all" never silently means "some". */
export function ApproveAllButton({ slug, ready }: { slug: string; ready: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const run = async () => {
    setBusy(true);
    setMessage(null);
    const res = await sendJson<ApproveAllResult>(`/api/brands/${slug}/cards/approve-all`, {});
    setBusy(false);
    if (!res.ok) return setMessage({ tone: "bad", text: res.error });
    const { approved, skipped } = res.data;
    setMessage({
      tone: "ok",
      text: `${approved.length} approved${skipped.length ? `, ${skipped.length} skipped (${[...new Set(skipped.map((s) => s.reason))].join(", ")})` : ""}.`,
    });
    router.refresh();
  };

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <Button onClick={run} disabled={busy || ready === 0}>
        {busy ? "Approving" : ready === 0 ? "Nothing to approve" : `Approve ${ready} draft${ready === 1 ? "" : "s"}`}
      </Button>
      {message && (
        <p role="status" className={`text-sm ${message.tone === "bad" ? "text-[color:var(--st-bad-fg)]" : "text-[color:var(--ink-dim)]"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}

/** Founder only: fills the plan's free days from the brand's viral videos. */
export function BuildPlanButton({ slug, label }: { slug: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<number | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    const res = await sendJson<{ taskId: number | null }>(`/api/admin/brands/${slug}/plan`, {});
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setTaskId(res.data.taskId);
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button variant="secondary" onClick={run} disabled={busy || taskId !== null}>
          {busy ? "Starting" : label}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-[color:var(--st-bad-fg)]">
          {error}
        </p>
      )}
      {taskId !== null && <TaskProgress taskId={taskId} title="Building the plan" onDone={() => router.refresh()} onRetry={() => setTaskId(null)} />}
    </div>
  );
}

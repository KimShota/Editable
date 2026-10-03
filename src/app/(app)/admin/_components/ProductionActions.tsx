"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { sendJson } from "../../../lib/clientApi";
import { TaskProgress } from "../../../_components/TaskProgress";
import { Button } from "../../../_components/ui";

/** One card in the production queue: price it, then release it (which spends). */
export function ProductionActions({ slug, cardId, hasEstimate, estimateMax, running }: { slug: string; cardId: string; hasEstimate: boolean; estimateMax: number | null; running: number | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<number | null>(running);
  const [confirming, setConfirming] = useState(false);

  const call = async (name: string, path: string) => {
    setBusy(name);
    setError(null);
    const res = await sendJson<{ taskId: number | null }>(`/api/admin/brands/${slug}/cards/${cardId}/${path}`, {});
    setBusy(null);
    if (!res.ok) return setError(res.error);
    setConfirming(false);
    setTaskId(res.data.taskId);
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {!hasEstimate && (
          <Button variant="secondary" onClick={() => call("estimate", "estimate")} disabled={busy !== null || taskId !== null} className="!px-4 !py-2 !text-[13px]">
            {busy === "estimate" ? "Starting" : "Get estimate"}
          </Button>
        )}
        {hasEstimate && !confirming && (
          <Button onClick={() => setConfirming(true)} disabled={busy !== null || taskId !== null} className="!px-4 !py-2 !text-[13px]">
            Release
          </Button>
        )}
        {confirming && (
          <>
            <Button onClick={() => call("release", "release")} disabled={busy !== null} className="!px-4 !py-2 !text-[13px]">
              {busy === "release" ? "Releasing" : `Spend up to $${(estimateMax ?? 0).toFixed(2)}`}
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(false)} className="!px-4 !py-2 !text-[13px]">
              Cancel
            </Button>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-[color:var(--st-bad-fg)]">
          {error}
        </p>
      )}
      {taskId !== null && (
        <TaskProgress
          taskId={taskId}
          title="Working"
          // Done: free the buttons again (an estimate finishing is what lets the
          // founder release), and re-read the queue.
          onDone={() => {
            setTaskId(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

/** The review gate's "Send to customer" for one video or a whole batch. */
export function SendButton({ slug, cardIds, label }: { slug: string; cardIds: string[]; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const run = async () => {
    setBusy(true);
    setMessage(null);
    const res = await sendJson<{ sent: string[]; emailed: number; emailError: string | null }>(`/api/admin/brands/${slug}/send`, { cardIds });
    setBusy(false);
    if (!res.ok) return setMessage({ tone: "bad", text: res.error });
    const { sent, emailed, emailError } = res.data;
    setMessage({ tone: emailError ? "bad" : "ok", text: `${sent.length} sent. ${emailed} email${emailed === 1 ? "" : "s"} sent${emailError ? `, but one failed: ${emailError}` : ""}.` });
    router.refresh();
  };

  return (
    <div className="flex flex-col items-start gap-2">
      <Button onClick={run} disabled={busy || cardIds.length === 0} className="!px-4 !py-2 !text-[13px]">
        {busy ? "Sending" : label}
      </Button>
      {message && (
        <p role="status" className={`text-sm ${message.tone === "bad" ? "text-[color:var(--st-bad-fg)]" : "text-[color:var(--ink-dim)]"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}

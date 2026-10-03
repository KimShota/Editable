"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { sendJson } from "../../../lib/clientApi";
import { Button } from "../../../_components/ui";

export type WaitingVideo = { id: string; day: number; dateLabel: string; hook: string; flagged: boolean };

type Result = { approved: string[]; skipped: { cardId: string; reason: string }[] };

/**
 * "Approve all remaining": every video waiting for review, in one go. It
 * lists them first (so "all" is never a surprise), and holds back any video QC
 * flagged unless the person ticks that they want those too.
 */
export function ApproveVideos({ slug, waiting }: { slug: string; waiting: WaitingVideo[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [includeFlagged, setIncludeFlagged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const flagged = waiting.filter((v) => v.flagged);
  const count = includeFlagged ? waiting.length : waiting.length - flagged.length;

  useEffect(() => {
    if (!open) return;
    confirm.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const run = async () => {
    setBusy(true);
    setMessage(null);
    const res = await sendJson<Result>(`/api/brands/${slug}/videos/approve-all`, { includeFlagged });
    setBusy(false);
    if (!res.ok) return setMessage({ tone: "bad", text: res.error });
    const { approved, skipped } = res.data;
    setMessage({ tone: "ok", text: `${approved.length} approved${skipped.length ? `, ${skipped.length} held back to look at first` : ""}.` });
    setOpen(false);
    router.refresh();
  };

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(true)}
        disabled={waiting.length === 0}
        aria-haspopup="dialog"
        className="inline-flex items-center justify-center rounded-full bg-[color:var(--ink)] px-6 py-3 font-[family-name:var(--font-display)] text-sm font-bold tracking-wide text-[color:var(--bg)] transition-transform hover:scale-[1.03] disabled:pointer-events-none disabled:opacity-40"
      >
        {waiting.length === 0 ? "Nothing to approve" : `Approve all remaining (${waiting.length})`}
      </button>
      {message && (
        <p role="status" className={`text-sm ${message.tone === "bad" ? "text-[color:var(--st-bad-fg)]" : "text-[color:var(--ink-dim)]"}`}>
          {message.text}
        </p>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={() => setOpen(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby="approve-title" onClick={(e) => e.stopPropagation()} className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-[color:var(--card)] p-6 shadow-xl">
            <h2 id="approve-title" className="font-[family-name:var(--font-display)] text-lg font-semibold text-[color:var(--ink)]">
              Approve these videos?
            </h2>
            <p className="mt-1 text-sm text-[color:var(--ink-dim)]">Approved videos are ready for you to post.</p>
            <ul className="mt-4 flex flex-col gap-2" aria-label="Videos to approve">
              {waiting.map((v) => (
                <li key={v.id} className={`flex items-start justify-between gap-3 rounded-xl border px-3 py-2.5 text-sm ${v.flagged && !includeFlagged ? "border-dashed text-[color:var(--ink-dim)]" : "border-[color:var(--card-border)] text-[color:var(--ink)]"}`}>
                  <span className="min-w-0">
                    <span className="font-medium">
                      Day {v.day}, {v.dateLabel}
                    </span>
                    <span className="block truncate text-[color:var(--ink-dim)]">{v.hook}</span>
                  </span>
                  {v.flagged && <span className="shrink-0 text-xs font-medium text-[color:var(--st-warn)]">{includeFlagged ? "Flagged" : "Held back"}</span>}
                </li>
              ))}
            </ul>
            {flagged.length > 0 && (
              <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm text-[color:var(--ink)]">
                <input type="checkbox" checked={includeFlagged} onChange={(e) => setIncludeFlagged(e.target.checked)} className="mt-0.5" />
                <span>Include the {flagged.length} flagged video{flagged.length === 1 ? "" : "s"}. A clip in {flagged.length === 1 ? "it" : "each"} only just passed our checks, so a look first is worth it.</span>
              </label>
            )}
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <button
                ref={confirm}
                type="button"
                onClick={run}
                disabled={busy || count === 0}
                className="inline-flex items-center justify-center rounded-full bg-[color:var(--ink)] px-6 py-3 font-[family-name:var(--font-display)] text-sm font-bold tracking-wide text-[color:var(--bg)] transition-transform hover:scale-[1.03] disabled:pointer-events-none disabled:opacity-40"
              >
                {busy ? "Approving" : `Approve ${count}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

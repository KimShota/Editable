"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { sendJson } from "../../../lib/clientApi";

/**
 * The manual way to post a ready video, for a calendar cell: download it,
 * copy its caption, and say where it went. (Posting for the customer arrives
 * with the platform integrations; the Post panel in the editor does the same
 * three things at more length.)
 */

const small = "rounded-full border border-[color:var(--card-border)] px-3 py-1 text-xs font-medium text-[color:var(--ink)] transition-colors hover:border-[color:var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)] disabled:opacity-40";

export function ManualPostActions({ slug, cardId, dayLabel, downloadUrl, copyText }: { slug: string; cardId: string; dayLabel: string; downloadUrl: string; copyText: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [urls, setUrls] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    field.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setMessage({ tone: "ok", text: "Copied." });
    } catch {
      setMessage({ tone: "bad", text: "Could not copy. Open the video to copy the caption by hand." });
    }
  };

  const markPosted = async () => {
    setBusy(true);
    setMessage(null);
    const res = await sendJson(`/api/brands/${slug}/cards/${cardId}/video`, { action: "mark_posted", urls: urls.split(/\s+/).filter(Boolean) });
    setBusy(false);
    if (!res.ok) return setMessage({ tone: "bad", text: res.error });
    setOpen(false);
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        <a href={downloadUrl} download className={small} aria-label={`Download the ${dayLabel} video`}>
          Download
        </a>
        <button type="button" onClick={copy} className={small} aria-label={`Copy the ${dayLabel} caption`}>
          Copy caption
        </button>
        <button ref={trigger} type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className={small} aria-label={`Mark the ${dayLabel} video as posted`}>
          Mark as posted
        </button>
      </div>
      {open && (
        <div role="group" aria-label={`Where was the ${dayLabel} video posted`} className="flex flex-col gap-1.5 rounded-xl bg-[color:var(--bg-2)] p-3">
          <label htmlFor={`posted-${cardId}`} className="text-xs font-medium text-[color:var(--ink)]">
            Where did you post it?
          </label>
          <textarea
            id={`posted-${cardId}`}
            ref={field}
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
            rows={2}
            placeholder="Paste up to 3 links, one per line"
            className="w-full rounded-lg border border-[color:var(--card-border)] bg-[color:var(--card)] px-2.5 py-2 text-xs text-[color:var(--ink)] outline-none placeholder:text-[color:var(--ink-dim)] focus:border-[color:var(--accent)]"
          />
          <div className="flex gap-2">
            <button type="button" onClick={markPosted} disabled={busy || !urls.trim()} className={`${small} !border-[color:var(--ink)] !bg-[color:var(--ink)] !text-[color:var(--bg)]`}>
              {busy ? "Saving" : "Save"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className={small}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {message && (
        <p role={message.tone === "bad" ? "alert" : "status"} className={`text-xs ${message.tone === "bad" ? "text-[color:var(--st-bad-fg)]" : "text-[color:var(--ink-dim)]"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}

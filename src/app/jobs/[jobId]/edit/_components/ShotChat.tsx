"use client";

import { useEffect, useRef, useState } from "react";
import { RegenerateIcon, SendIcon } from "./Icons";

/**
 * An AI clip's change chat, in the Inspector under its takes: say what
 * should be different ("her hand taps the trackpad instead of typing") and
 * Claude answers with a plan for a new take and its price. Nothing is spent
 * until Generate is pressed on a plan; the new take then lands in Takes like
 * any other, and the chat remembers which plan made it. Messages come from
 * /api/jobs/[jobId]/shot-chat; the list reloads when the clip's take changes
 * or a generation finishes.
 */

type Plan = { action: "regenerate" | "none"; motion: string | null; stillEdit: string | null; label: string; estimateUsd?: number };
type Message = { id: string; role: "user" | "assistant"; text: string; at: string; plan?: Plan; takeId?: string };

const takeNumber = (takeId: string) => takeId.split("-t").pop();

export function ShotChat({
  jobId,
  clipId,
  currentSrc,
  busy,
  onGenerate,
}: {
  jobId: string;
  clipId: string;
  /** The clip's current source: a new take (or undo) reloads the chat. */
  currentSrc: string;
  /** A take of this clip is generating. */
  busy: boolean;
  onGenerate: (planId: string) => void;
}) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/jobs/${jobId}/shot-chat?clipId=${encodeURIComponent(clipId)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((d: { messages: Message[] }) => {
        if (!cancelled) setMessages(d.messages);
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, clipId, currentSrc, busy]);

  // Keep the newest message in view.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, pendingText]);

  const send = async () => {
    const text = draft.trim();
    if (!text || pendingText) return;
    setPendingText(text);
    setDraft("");
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/shot-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clipId, message: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "the chat failed");
      setMessages(data.messages as Message[]);
    } catch (err) {
      setError((err as Error).message);
      setDraft(text);
    } finally {
      setPendingText(null);
    }
  };

  if (!messages) return null;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-[color:var(--ed-ink-dim)]">Change this shot</p>
      {(messages.length > 0 || pendingText) && (
        <div ref={listRef} className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-0.5">
          {messages.map((m) =>
            m.role === "user" ? (
              <p key={m.id} className="ml-6 self-end rounded-lg rounded-br-sm bg-[color:var(--ed-accent-dim)] px-2.5 py-1.5 text-xs leading-snug text-[color:var(--ed-ink)]">
                {m.text}
              </p>
            ) : (
              <div key={m.id} className="mr-6 flex flex-col gap-1.5 rounded-lg rounded-bl-sm bg-[color:var(--ed-raised)] px-2.5 py-1.5">
                <p className="text-xs leading-snug text-[color:var(--ed-ink)]">{m.text}</p>
                {m.plan?.action === "regenerate" && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] text-[color:var(--ed-ink-faint)]">
                      {[m.plan.motion && "new motion", m.plan.stillEdit && "edited still", !m.plan.motion && !m.plan.stillEdit && "same prompt"].filter(Boolean).join(" + ")}
                    </span>
                    {m.takeId ? (
                      <span className="ml-auto text-[10px] font-semibold text-[color:var(--ed-accent)]">Made take {takeNumber(m.takeId)}</span>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onGenerate(m.id)}
                        title="Make this take. Only this clip changes; undo brings the old take back."
                        className="ml-auto flex items-center gap-1 rounded-md bg-[color:var(--ed-accent)] px-2 py-1 text-[11px] font-semibold text-[color:var(--ed-accent-ink)] transition-transform hover:scale-[1.03] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50"
                      >
                        {busy && <RegenerateIcon className="h-3 w-3 animate-spin" />}
                        {busy ? "Generating…" : `Generate · $${(m.plan.estimateUsd ?? 0).toFixed(2)}`}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ),
          )}
          {pendingText && (
            <>
              <p className="ml-6 self-end rounded-lg rounded-br-sm bg-[color:var(--ed-accent-dim)] px-2.5 py-1.5 text-xs leading-snug text-[color:var(--ed-ink)]">{pendingText}</p>
              <p className="mr-6 animate-pulse rounded-lg rounded-bl-sm bg-[color:var(--ed-raised)] px-2.5 py-1.5 text-xs text-[color:var(--ed-ink-faint)]">Looking at the shot…</p>
            </>
          )}
        </div>
      )}
      <div className="flex items-end gap-1.5">
        <textarea
          value={draft}
          rows={2}
          maxLength={1000}
          disabled={!!pendingText}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={messages.length ? "Ask for another change…" : "What should be different? e.g. her hand taps the trackpad instead of typing"}
          className="min-h-[3.25rem] flex-1 resize-none rounded-lg border border-[color:var(--ed-border-strong)] bg-[color:var(--ed-raised)] px-2 py-1.5 text-xs leading-snug text-[color:var(--ed-ink)] outline-none placeholder:text-[color:var(--ed-ink-faint)] focus:border-[color:var(--ed-accent)] disabled:opacity-60"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={!draft.trim() || !!pendingText}
          title="Send (Enter)"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[color:var(--ed-accent)] text-[color:var(--ed-accent-ink)] transition-transform hover:scale-105 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
        >
          <SendIcon className="h-4 w-4" />
        </button>
      </div>
      {error && <p className="text-[11px] text-[color:var(--ed-danger)]">{error}</p>}
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CardStatus } from "@backend/plan/schemas";
import { sendJson } from "../../../../lib/clientApi";
import { PRODUCTION_STAGES } from "@backend/queue/stages";
import { TaskProgress } from "../../../../_components/TaskProgress";
import { canAutoOpenEditor } from "../../../../lib/autoOpenEditor";
import { Button, ButtonLink, StatusBadge } from "../../../../_components/ui";

/**
 * One plan card, for review (plan/ui-ux-full-flow.md §4): the source video,
 * its lines next to the brand's adapted lines (editable while the card is a
 * draft), the shot strip, and the actions that change the card.
 *
 * The server page decides what is true (status, script, files); this
 * component only holds what the person is typing and what they just started.
 */

export type Row = { index: number; role: string; startSec: number; sourceText: string; text: string; sourceWords: number };
export type Shot = { id: string; treatment: string; action: string; image: string | null; imageIsStoryboard: boolean };

type Props = {
  slug: string;
  cardId: string;
  dayLabel: string;
  status: CardStatus;
  lowConfidence: boolean;
  angle: string;
  whyItWorks: string | null;
  videoUrl: string | null;
  rows: Row[];
  shots: Shot[];
  swapOptions: { sourceId: string; label: string }[];
  /** Whose words the status badge uses: the founder sees internal review, a customer sees "Generating". */
  audience: "admin" | "customer";
  /** The editor for this card's video, and whether there is a video this viewer may open yet. */
  editorPath: string;
  canOpenEditor: boolean;
  /** Work running on this card: planning steps and, once released, the video itself. */
  liveTasks: { id: number; kind: string }[];
  prevId: string | null;
  nextId: string | null;
};

const TREATMENTS: Record<string, string> = {
  character_talking: "Character speaks",
  character_with_device: "Character with device",
  device_closeup: "Device close-up",
  screen_fill: "Screen recording",
  broll: "B-roll",
  text_card: "Text card",
};

const clock = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** A plain-language note when a line is far from the original's length: the
 *  adapted video keeps the source's timing, so a much longer line will not fit. */
const lengthHint = (text: string, sourceWords: number): string | null => {
  const n = words(text);
  if (sourceWords < 4 || n === 0) return null;
  const ratio = n / sourceWords;
  if (ratio > 1.3) return `Longer than the original (${n} words, the original has ${sourceWords}). It may not fit the shot.`;
  if (ratio < 0.7) return `Shorter than the original (${n} words, the original has ${sourceWords}). The shot may feel empty.`;
  return null;
};

type LiveTask = { id: number; title: string; producing: boolean };
/** Making the video itself gets its own title and the staged bar (Voice, Clips, Finishing). */
const asLiveTask = (t: { id: number; kind: string }): LiveTask =>
  t.kind === "video.produce" ? { id: t.id, title: "Making your video", producing: true } : { id: t.id, title: "Working on this video", producing: false };

export function CardWorkspace(props: Props) {
  const { slug, cardId, status, rows, shots, swapOptions } = props;
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const editable = status === "draft";

  // Keyed on the rows' content, not their identity: the server re-sends a
  // fresh array on every refresh, and resetting then would wipe what the
  // person is typing.
  const signature = rows.map((r) => `${r.index}:${r.text}`).join("\u0001");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const saved = useMemo(() => Object.fromEntries(rows.map((r) => [r.index, r.text])) as Record<number, string>, [signature]);
  const [texts, setTexts] = useState<Record<number, string>>(saved);
  const [tasks, setTasks] = useState<LiveTask[]>(props.liveTasks.map(asLiveTask));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [swapTo, setSwapTo] = useState("");

  // The server sends fresh rows after a save or a rewrite; start typing from those.
  useEffect(() => setTexts(saved), [saved]);
  const liveKey = props.liveTasks.map((t) => t.id).join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setTasks(props.liveTasks.map(asLiveTask)), [liveKey]);

  const changed = rows.filter((r) => texts[r.index] !== r.text).map((r) => ({ index: r.index, text: texts[r.index] ?? r.text }));
  const dirty = changed.length > 0;
  const writing = tasks.length > 0;
  const producing = tasks.some((t) => t.producing);
  const locked = !editable || writing;

  // Left and right arrows move between days, unless the person is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowLeft" && props.prevId) router.push(`/plan/${props.prevId}`);
      if (e.key === "ArrowRight" && props.nextId) router.push(`/plan/${props.nextId}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.prevId, props.nextId, router]);

  const act = async (name: string, run: () => Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }>, then?: (data: Record<string, unknown>) => void) => {
    setBusy(name);
    setError(null);
    setNotice(null);
    const res = await run();
    setBusy(null);
    if (!res.ok) return setError(res.error);
    then?.(res.data);
    router.refresh();
  };

  const startTask = (title: string) => (data: Record<string, unknown>) => {
    const id = typeof data.taskId === "number" ? data.taskId : null;
    if (id !== null) setTasks((t) => (t.some((x) => x.id === id) ? t : [...t, { id, title, producing: false }]));
  };

  const save = () => act("save", () => sendJson(`/api/brands/${slug}/cards/${cardId}/script`, { lines: changed }, "PUT"), () => setNotice("Saved."));
  const post = (action: string, extra: Record<string, unknown> = {}) => sendJson(`/api/brands/${slug}/cards/${cardId}`, { action, ...extra });

  const seek = (sec: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = sec;
    void v.play().catch(() => undefined);
  };

  const stillCount = shots.filter((s) => s.imageIsStoryboard).length;

  return (
    <div className="flex flex-col gap-10">
      {/* Status and the actions that change the card */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <StatusBadge status={status} lowConfidence={props.lowConfidence} audience={props.audience} />
          {writing && <span className="text-sm text-[color:var(--ink-dim)]">{producing ? "Being made" : "Writing in progress"}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {props.canOpenEditor && <ButtonLink href={props.editorPath}>Open the video</ButtonLink>}
          {status === "draft" && (
            <Button onClick={() => act("approve", () => post("approve"))} disabled={busy !== null || dirty || writing || rows.length === 0}>
              {busy === "approve" ? "Approving" : "Approve"}
            </Button>
          )}
          {status === "approved" && (
            <Button variant="secondary" onClick={() => act("unapprove", () => post("unapprove"))} disabled={busy !== null}>
              {busy === "unapprove" ? "Working" : "Unapprove"}
            </Button>
          )}
        </div>
      </div>
      {status === "draft" && dirty && <p className="-mt-6 text-sm text-[color:var(--ink-dim)]">Save your changes before approving.</p>}
      {!editable && status === "approved" && <p className="-mt-6 max-w-[65ch] text-sm text-[color:var(--ink-dim)]">This video is approved and queued for production. Unapprove it to change the script.</p>}

      {error && (
        <p role="alert" className="rounded-xl border border-[color:var(--st-bad-fg)]/30 bg-[color:var(--st-bad-bg)] px-4 py-3 text-sm text-[color:var(--st-bad-fg)]">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-[color:var(--ink-dim)]">
          {notice}
        </p>
      )}

      {tasks.length > 0 && (
        <div className="flex flex-col gap-3">
          {tasks.map((t) => (
            <TaskProgress
              key={t.id}
              taskId={t.id}
              title={t.title}
              stages={t.producing ? PRODUCTION_STAGES : undefined}
              // A video the founder watched being made opens in the editor as soon as it is done.
              onDone={() => (t.producing && props.audience === "admin" && canAutoOpenEditor() ? router.push(props.editorPath) : router.refresh())}
            />
          ))}
        </div>
      )}

      {props.whyItWorks && (
        <section aria-labelledby="why-title">
          <h2 id="why-title" className="font-[family-name:var(--font-display)] text-base font-semibold text-[color:var(--ink)]">
            Why the original works
          </h2>
          <p className="mt-1 max-w-[65ch] text-[15px] leading-relaxed text-[color:var(--ink-dim)]">{props.whyItWorks}</p>
        </section>
      )}

      {/* Original video, original lines, adapted lines */}
      <section aria-labelledby="script-title" className="grid gap-8 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <div className="lg:sticky lg:top-6 lg:self-start">
          {props.videoUrl ? (
            <video ref={videoRef} src={props.videoUrl} controls playsInline preload="metadata" className="aspect-[9/16] w-full max-w-[16rem] rounded-2xl bg-[color:var(--ink)] object-contain" aria-label="The original viral video" />
          ) : (
            <div className="flex aspect-[9/16] w-full max-w-[16rem] items-center justify-center rounded-2xl bg-[color:var(--bg-2)] px-4 text-center text-sm text-[color:var(--ink-dim)]">The original video is not available.</div>
          )}
        </div>

        <div>
          <h2 id="script-title" className="sr-only">
            Script
          </h2>
          {rows.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-[color:var(--card-border)] px-5 py-10 text-center text-[15px] text-[color:var(--ink-dim)]">
              {writing ? "The script is being written. It will appear here." : "This video has no script yet."}
            </p>
          ) : (
            <ol className="flex flex-col gap-6">
              <li aria-hidden="true" className="hidden grid-cols-2 gap-6 font-[family-name:var(--font-display)] text-xs font-semibold tracking-wide text-[color:var(--ink-dim)] uppercase md:grid">
                <span>Original</span>
                <span>Your version</span>
              </li>
              {rows.map((r) => {
                const value = texts[r.index] ?? r.text;
                const hint = editable ? lengthHint(value, r.sourceWords) : null;
                return (
                  <li key={r.index} data-line={r.index} className="grid gap-3 md:grid-cols-2 md:gap-6">
                    <div className="min-w-0">
                      <p className="flex items-center gap-3 text-xs text-[color:var(--ink-dim)]">
                        <span className="font-[family-name:var(--font-display)] font-semibold tracking-wide uppercase">{r.role}</span>
                        {props.videoUrl && (
                          <button type="button" onClick={() => seek(r.startSec)} className="rounded-full border border-[color:var(--card-border)] px-2.5 py-0.5 font-medium text-[color:var(--ink)] transition-colors hover:border-[color:var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]" aria-label={`Play the original from ${clock(r.startSec)}`}>
                            Play from {clock(r.startSec)}
                          </button>
                        )}
                      </p>
                      <p className="mt-1.5 text-[15px] leading-relaxed text-[color:var(--ink-dim)]">{r.sourceText}</p>
                    </div>
                    <div className="min-w-0">
                      <label htmlFor={`line-${r.index}`} className="text-xs font-semibold tracking-wide text-[color:var(--ink)] uppercase md:sr-only">
                        Your version
                      </label>
                      <textarea
                        id={`line-${r.index}`}
                        value={value}
                        onChange={(e) => setTexts((t) => ({ ...t, [r.index]: e.target.value }))}
                        disabled={locked}
                        rows={Math.max(2, Math.ceil(value.length / 52))}
                        maxLength={400}
                        aria-describedby={hint ? `hint-${r.index}` : undefined}
                        className="mt-1.5 w-full resize-y rounded-xl border border-[color:var(--card-border)] bg-[color:var(--card)] px-3.5 py-3 text-[15px] leading-relaxed text-[color:var(--ink)] outline-none focus:border-[color:var(--accent)] disabled:bg-[color:var(--bg-2)] disabled:text-[color:var(--ink-dim)] md:mt-0"
                      />
                      {hint && (
                        <p id={`hint-${r.index}`} className="mt-1.5 text-[13px] text-[color:var(--st-working-fg)]">
                          {hint}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          {editable && rows.length > 0 && (
            <div className="mt-6 flex flex-wrap items-center gap-3 md:ml-[calc(50%+0.75rem)]">
              <Button onClick={save} disabled={!dirty || busy !== null || writing}>
                {busy === "save" ? "Saving" : "Save changes"}
              </Button>
              {dirty && (
                <button type="button" onClick={() => setTexts(saved)} className="text-sm font-medium text-[color:var(--ink-dim)] underline-offset-4 hover:text-[color:var(--ink)] hover:underline">
                  Discard changes
                </button>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Shots */}
      {shots.length > 0 && (
        <section aria-labelledby="shots-title">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 id="shots-title" className="font-[family-name:var(--font-display)] text-base font-semibold text-[color:var(--ink)]">
                Shots
              </h2>
              <p className="mt-1 max-w-[65ch] text-sm text-[color:var(--ink-dim)]">{stillCount > 0 ? "Pictures of how each shot will look with your character." : "Frames from the original. Generate a storyboard to see each shot with your character."}</p>
            </div>
            {stillCount === 0 && rows.length > 0 && (
              <Button variant="secondary" onClick={() => act("storyboard", () => post("storyboard"), startTask("Generating storyboard"))} disabled={busy !== null || writing}>
                {busy === "storyboard" ? "Starting" : "Generate storyboard"}
              </Button>
            )}
          </div>
          <ul className="-mx-4 mt-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
            {shots.map((s) => (
              <li key={s.id} className="w-32 shrink-0 snap-start">
                {s.image ? (
                  <img src={s.image} alt={s.imageIsStoryboard ? `Storyboard for ${s.id}: ${s.action}` : `Original frame of ${s.id}`} className="aspect-[9/16] w-full rounded-xl bg-[color:var(--bg-2)] object-cover" />
                ) : (
                  <div aria-hidden="true" className="aspect-[9/16] w-full rounded-xl bg-[color:var(--bg-2)]" />
                )}
                <p className="mt-2 text-[13px] font-medium text-[color:var(--ink)]">{TREATMENTS[s.treatment] ?? s.treatment}</p>
                <p className="text-xs text-[color:var(--ink-dim)]">{s.imageIsStoryboard ? s.id : `${s.id}, original`}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Changing the video */}
      {editable && rows.length > 0 && (
        <section aria-labelledby="change-title" className="grid gap-6 border-t border-[color:var(--card-border)] pt-8 md:grid-cols-2">
          <div className="flex flex-col gap-2">
            <h2 id="change-title" className="font-[family-name:var(--font-display)] text-base font-semibold text-[color:var(--ink)]">
              Write it again
            </h2>
            <label htmlFor="rewrite-note" className="text-sm font-medium text-[color:var(--ink)]">
              What should change? (optional)
            </label>
            <textarea
              id="rewrite-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy !== null || writing}
              rows={2}
              maxLength={500}
              placeholder="Make it more playful, and mention the free trial."
              className="rounded-xl border border-[color:var(--card-border)] bg-[color:var(--card)] px-3.5 py-3 text-[15px] text-[color:var(--ink)] outline-none placeholder:text-[color:var(--ink-dim)] focus:border-[color:var(--accent)]"
            />
            <div>
              <Button variant="secondary" onClick={() => act("rewrite", () => post("rewrite", note.trim() ? { note: note.trim() } : {}), (d) => { setNote(""); startTask("Writing a new script")(d); })} disabled={busy !== null || writing || dirty}>
                {busy === "rewrite" ? "Starting" : "Rewrite script"}
              </Button>
            </div>
            {dirty && <p className="text-[13px] text-[color:var(--ink-dim)]">Save or discard your edits first. A rewrite replaces them.</p>}
          </div>

          {swapOptions.length > 0 && (
            <div className="flex flex-col gap-2">
              <h2 className="font-[family-name:var(--font-display)] text-base font-semibold text-[color:var(--ink)]">Use a different video</h2>
              <label htmlFor="swap-source" className="text-sm font-medium text-[color:var(--ink)]">
                Recreate another viral video instead
              </label>
              <select
                id="swap-source"
                value={swapTo}
                onChange={(e) => setSwapTo(e.target.value)}
                disabled={busy !== null || writing}
                className="rounded-xl border border-[color:var(--card-border)] bg-[color:var(--card)] px-3.5 py-3 text-[15px] text-[color:var(--ink)] outline-none focus:border-[color:var(--accent)]"
              >
                <option value="">Choose a video</option>
                {swapOptions.map((o) => (
                  <option key={o.sourceId} value={o.sourceId}>
                    {o.label}
                  </option>
                ))}
              </select>
              <div>
                <Button variant="secondary" onClick={() => act("swap", () => post("swap", { sourceId: swapTo }), (d) => { setSwapTo(""); startTask("Writing a new script")(d); })} disabled={!swapTo || busy !== null || writing || dirty}>
                  {busy === "swap" ? "Switching" : "Switch video"}
                </Button>
              </div>
              <p className="text-[13px] text-[color:var(--ink-dim)]">A new script is written, and any storyboard for this day is cleared.</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

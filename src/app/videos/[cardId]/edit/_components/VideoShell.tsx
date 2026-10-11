"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { CardStatus } from "@backend/plan/schemas";
import { sendJson } from "../../../../lib/clientApi";
import { StatusBadge } from "../../../../_components/ui";
import { type AiVideoSource, AiVideoSourceProvider } from "../../../../jobs/[jobId]/edit/_components/AiVideoSource";

/**
 * The frame around the editor for a brand's video (plan/ui-ux-full-flow.md
 * §5): a bar with where this is in the plan, the video's status and the Post
 * panel (caption, download, mark as posted). The editor itself fills the
 * rest and is unchanged.
 */

export type PostInfo = { caption: string; hashtags: string[]; platforms: string[]; postedUrls: string[] };

type Props = {
  slug: string;
  cardId: string;
  dayLabel: string;
  angle: string;
  status: CardStatus;
  lowConfidence: boolean;
  source: AiVideoSource | null;
  post: PostInfo;
  plannedLabel: string;
  downloadUrl: string;
  children: ReactNode;
};

const PLATFORMS = [
  { id: "tiktok", label: "TikTok" },
  { id: "instagram", label: "Instagram Reels" },
  { id: "youtube", label: "YouTube Shorts" },
];

const button = "rounded-lg px-3.5 py-1.5 font-[family-name:var(--ed-font-display)] text-[13px] font-semibold transition-transform active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--ed-focus)]";
const primary = `${button} bg-[color:var(--ed-accent)] text-[color:var(--ed-accent-ink)]`;
const secondary = `${button} border border-[color:var(--ed-border-strong)] text-[color:var(--ed-ink)] hover:bg-[color:var(--ed-raised-hover)]`;
const field = "w-full rounded-lg border border-[color:var(--ed-border-strong)] bg-[color:var(--ed-raised)] px-3 py-2 text-sm text-[color:var(--ed-ink)] outline-none placeholder:text-[color:var(--ed-ink-faint)] focus:border-[color:var(--ed-accent)]";

export function VideoShell(props: Props) {
  const { status } = props;
  const [postOpen, setPostOpen] = useState(false);
  const postButton = useRef<HTMLButtonElement>(null);

  return (
    <div className="editor-theme fixed inset-0 z-10 flex flex-col">
      <header className="relative flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-[color:var(--ed-border)] bg-[color:var(--ed-panel)] px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/calendar" className="shrink-0 text-[13px] font-medium text-[color:var(--ed-ink-dim)] underline-offset-4 hover:text-[color:var(--ed-ink)] hover:underline">
            Calendar
          </Link>
          <span aria-hidden="true" className="h-4 w-px shrink-0 bg-[color:var(--ed-border-strong)]" />
          <p className="min-w-0 truncate text-[13px] text-[color:var(--ed-ink)]">
            <span className="font-semibold">{props.dayLabel}</span>
            <span className="text-[color:var(--ed-ink-dim)]">{`  ${props.angle}`}</span>
          </p>
          <StatusBadge status={status} lowConfidence={props.lowConfidence} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button ref={postButton} type="button" className={status === "ready" ? primary : secondary} aria-haspopup="dialog" aria-expanded={postOpen} onClick={() => setPostOpen((v) => !v)}>
            Post
          </button>
        </div>
      </header>

      <AiVideoSourceProvider value={props.source}>
        <div className="relative min-h-0 flex-1">{props.children}</div>
      </AiVideoSourceProvider>

      {postOpen && <PostPanel {...props} onClose={() => { setPostOpen(false); postButton.current?.focus(); }} />}
    </div>
  );
}

const hashtagsOf = (text: string): string[] => [...new Set(text.split(/[\s,]+/).map((h) => h.replace(/^#+/, "")).filter(Boolean))];

/** Caption, where it is going, and the manual steps: download, copy, mark as
 *  posted. Auto-posting is not available yet, and says so. */
function PostPanel({ slug, cardId, status, post, plannedLabel, downloadUrl, onClose }: Props & { onClose: () => void }) {
  const router = useRouter();
  const [caption, setCaption] = useState(post.caption);
  const [tags, setTags] = useState(post.hashtags.join(" "));
  const [urls, setUrls] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const first = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tagList = hashtagsOf(tags);
  const dirty = caption !== post.caption || tagList.join(" ") !== post.hashtags.join(" ");
  const posted = status === "posted";

  const save = async () => {
    setBusy("save");
    setMessage(null);
    const res = await sendJson(`/api/brands/${slug}/cards/${cardId}/post`, { caption, hashtags: tagList, platforms: post.platforms }, "PUT");
    setBusy(null);
    if (!res.ok) return setMessage({ tone: "bad", text: res.error });
    setMessage({ tone: "ok", text: "Saved." });
    router.refresh();
  };

  const copy = async () => {
    const text = [caption.trim(), tagList.map((h) => `#${h}`).join(" ")].filter(Boolean).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setMessage({ tone: "ok", text: "Copied. Paste it into your post." });
    } catch {
      setMessage({ tone: "bad", text: "Your browser would not let us copy. Select the caption and copy it by hand." });
    }
  };

  const markPosted = async () => {
    setBusy("posted");
    setMessage(null);
    const links = urls.split(/\s+/).filter(Boolean);
    const res = await sendJson(`/api/brands/${slug}/cards/${cardId}/video`, { action: "mark_posted", urls: links });
    setBusy(null);
    if (!res.ok) return setMessage({ tone: "bad", text: res.error });
    router.refresh();
  };

  return (
    <aside role="dialog" aria-label="Post details" className="fixed top-12 right-0 bottom-0 z-40 flex w-full max-w-sm flex-col gap-5 overflow-y-auto border-l border-[color:var(--ed-border-strong)] bg-[color:var(--ed-panel)] p-5 shadow-xl">
      <div className="flex items-center justify-between">
        <h2 className="font-[family-name:var(--ed-font-display)] text-base font-semibold text-[color:var(--ed-ink)]">Post this video</h2>
        <button type="button" onClick={onClose} aria-label="Close post details" className="rounded-lg px-2 py-1 text-sm text-[color:var(--ed-ink-dim)] hover:bg-[color:var(--ed-raised-hover)]">
          Close
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="post-caption" className="text-sm font-medium text-[color:var(--ed-ink)]">
          Caption
        </label>
        <textarea id="post-caption" ref={first} value={caption} onChange={(e) => setCaption(e.target.value)} rows={5} maxLength={2200} disabled={posted} className={field} />
        <p className="text-xs text-[color:var(--ed-ink-dim)]">{caption.length} of 2,200</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="post-tags" className="text-sm font-medium text-[color:var(--ed-ink)]">
          Hashtags
        </label>
        <input id="post-tags" value={tags} onChange={(e) => setTags(e.target.value)} disabled={posted} placeholder="ai productivity mac" className={field} />
        {tagList.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Chosen hashtags">
            {tagList.map((h) => (
              <li key={h} className="rounded-full bg-[color:var(--ed-raised)] px-2.5 py-0.5 text-xs text-[color:var(--ed-ink)]">{`#${h}`}</li>
            ))}
          </ul>
        )}
      </div>

      {!posted && (
        <div className="flex gap-2">
          <button type="button" className={secondary} onClick={save} disabled={!dirty || busy !== null}>
            {busy === "save" ? "Saving" : "Save details"}
          </button>
          <button type="button" className={secondary} onClick={copy}>
            Copy caption and hashtags
          </button>
        </div>
      )}

      <fieldset className="flex flex-col gap-2 border-t border-[color:var(--ed-border)] pt-4">
        <legend className="text-sm font-medium text-[color:var(--ed-ink)]">Where it will go</legend>
        <div className="flex flex-col gap-1.5">
          {PLATFORMS.map((p) => (
            <label key={p.id} className="flex items-center gap-2 text-sm text-[color:var(--ed-ink-dim)]">
              <input type="checkbox" disabled checked={post.platforms.includes(p.id)} readOnly />
              {p.label}
            </label>
          ))}
        </div>
        <p className="text-xs text-[color:var(--ed-ink-dim)]">Posting for you is coming soon. For now, download the video and post it yourself.</p>
        <p className="text-sm text-[color:var(--ed-ink)]">Planned for {plannedLabel}</p>
      </fieldset>

      <div className="flex flex-col gap-3 border-t border-[color:var(--ed-border)] pt-4">
        <a href={downloadUrl} download className={`${secondary} inline-block text-center`}>
          Download MP4
        </a>

        {posted ? (
          <div>
            <p className="text-sm font-medium text-[color:var(--ed-ink)]">Posted</p>
            <ul className="mt-1 flex flex-col gap-1 text-sm">
              {post.postedUrls.map((u) => (
                <li key={u} className="truncate">
                  <a href={u} target="_blank" rel="noreferrer noopener" className="text-[color:var(--ed-accent)] underline-offset-4 hover:underline">
                    {u}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : status === "ready" ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="post-urls" className="text-sm font-medium text-[color:var(--ed-ink)]">
              Where did you post it?
            </label>
            <textarea id="post-urls" value={urls} onChange={(e) => setUrls(e.target.value)} rows={3} placeholder={"https://www.tiktok.com/@you/video/…\nhttps://www.instagram.com/reel/…"} className={field} />
            <p className="text-xs text-[color:var(--ed-ink-dim)]">Paste up to 3 links, one per line.</p>
            <div>
              <button type="button" className={primary} onClick={markPosted} disabled={!urls.trim() || busy !== null}>
                {busy === "posted" ? "Saving" : "Mark as posted"}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-[color:var(--ed-ink-dim)]">This video is not ready to post yet.</p>
        )}
      </div>

      {message && (
        <p role={message.tone === "bad" ? "alert" : "status"} className={`text-sm ${message.tone === "bad" ? "text-[color:var(--ed-danger)]" : "text-[color:var(--ed-ink-dim)]"}`}>
          {message.text}
        </p>
      )}
    </aside>
  );
}

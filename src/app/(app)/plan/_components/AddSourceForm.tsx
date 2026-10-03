"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { sendJson } from "../../../lib/clientApi";
import { TaskProgress } from "../../../_components/TaskProgress";
import { Button } from "../../../_components/ui";

/**
 * "Add a viral video": paste a link, and it is downloaded and broken down so
 * the plan can recreate it. The link is checked on the server (Instagram,
 * TikTok or YouTube Shorts only); what it says is shown here as it came.
 */
export function AddSourceForm({ slug }: { slug: string }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<number | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await sendJson<{ taskId: number | null }>(`/api/brands/${slug}/sources`, { url });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setUrl("");
    setTaskId(res.data.taskId);
    router.refresh();
  };

  return (
    <section aria-labelledby="add-video-title" className="rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] p-5">
      <h2 id="add-video-title" className="font-[family-name:var(--font-display)] text-base font-semibold text-[color:var(--ink)]">
        Add a viral video
      </h2>
      <p className="mt-1 max-w-[65ch] text-sm text-[color:var(--ink-dim)]">Paste a link to an Instagram reel, a TikTok or a YouTube Short you would like your character to recreate.</p>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-2">
        <label htmlFor="viral-url" className="text-sm font-medium text-[color:var(--ink)]">
          Link
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id="viral-url"
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.instagram.com/reel/…"
            disabled={busy}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "viral-url-error" : undefined}
            className="min-w-0 flex-1 rounded-lg border border-[color:var(--card-border)] bg-[color:var(--bg-2)] px-4 py-3 text-sm text-[color:var(--ink)] outline-none placeholder:text-[color:var(--ink-dim)] focus:border-[color:var(--accent)]"
          />
          <Button type="submit" disabled={busy || !url.trim()} className="sm:shrink-0">
            {busy ? "Adding" : "Add video"}
          </Button>
        </div>
        {error && (
          <p id="viral-url-error" role="alert" className="text-sm text-[color:var(--st-bad-fg)]">
            {error}
          </p>
        )}
      </form>
      {taskId !== null && <TaskProgress taskId={taskId} title="Adding your video" className="mt-4" onDone={() => router.refresh()} />}
    </section>
  );
}

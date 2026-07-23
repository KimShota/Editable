"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card } from "../../../_components/ui";

export function NewDraftForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/authoring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed to start authoring");
      router.push(`/authoring/${data.draftId}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Card className="p-6">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div>
          <label className="mb-2 block text-sm font-medium text-[color:var(--ink)]">Reel URL</label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.tiktok.com/@.../video/... or an Instagram Reel / YouTube Shorts link"
            className="w-full rounded-lg border border-white/12 bg-black/20 px-4 py-3 text-sm text-[color:var(--ink)] outline-none placeholder:text-[color:var(--ink-dim)] focus:border-[color:var(--accent)]"
            disabled={busy}
          />
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <Button type="submit" disabled={busy || !url.trim()}>
          {busy ? "Starting…" : "Reverse-engineer this reel"}
        </Button>
        <p className="text-xs text-[color:var(--ink-dim)]">
          This downloads the video, transcribes it, samples its frames, and calls an LLM to draft a
          reusable format. Takes a minute or two — you'll see progress on the next screen.
        </p>
      </form>
    </Card>
  );
}

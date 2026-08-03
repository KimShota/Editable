"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Card, Pill } from "../../_components/ui";
import type { FormatSummary } from "../../lib/formats";
import type { JobSummary } from "../../lib/jobs";

/** Compact social-count formatting: 2649446 -> "2.6M", 10616 -> "10.6K".
 *  Truncates rather than rounds up (34898 -> "34.8K", not "34.9K") to match
 *  how every mainstream platform displays these counts. */
const formatCount = (n: number): string => {
  if (n >= 1_000_000) return `${Math.floor((n / 1_000_000) * 10) / 10}M`;
  if (n >= 1_000) return `${Math.floor((n / 1_000) * 10) / 10}K`;
  return String(n);
};

type Tab = "browse" | "mine";

export function TemplateGallery({
  formats,
  pastJobs,
}: {
  formats: FormatSummary[];
  pastJobs: JobSummary[];
}) {
  const [tab, setTab] = useState<Tab>("browse");
  const [query, setQuery] = useState("");
  const [niche, setNiche] = useState<string | null>(null);

  const niches = useMemo(() => Array.from(new Set(formats.map((f) => f.niche))).sort(), [formats]);

  const filtered = formats.filter((f) => {
    if (niche && f.niche !== niche) return false;
    if (!query.trim()) return true;
    const haystack = `${f.name} ${f.niche} ${f.description}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-center gap-4 border-b border-white/10 pb-6">
        <div className="flex gap-1 rounded-full border border-white/10 p-1">
          {(["browse", "mine"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-full px-4 py-1.5 font-[family-name:var(--font-display)] text-[13px] tracking-wide transition-colors ${
                tab === t ? "bg-[color:var(--accent)] text-[color:var(--accent-ink)]" : "text-[color:var(--ink-dim)] hover:text-[color:var(--ink)]"
              }`}
            >
              {t === "browse" ? "Browse" : `My templates (${pastJobs.length})`}
            </button>
          ))}
        </div>

        {tab === "browse" && (
          <>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search niche or format…"
              className="min-w-[220px] flex-1 rounded-full border border-white/12 bg-transparent px-4 py-2 text-sm text-[color:var(--ink)] outline-none placeholder:text-[color:var(--ink-dim)] focus:border-[color:var(--accent)]"
            />
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setNiche(null)}>
                <Pill tone={niche === null ? "accent" : "default"}>All niches</Pill>
              </button>
              {niches.map((n) => (
                <button key={n} onClick={() => setNiche(n)}>
                  <Pill tone={niche === n ? "accent" : "default"}>{n}</Pill>
                </button>
              ))}
            </div>
          </>
        )}

        <Link
          href="/authoring/new"
          className="ml-auto rounded-full bg-[color:var(--accent)] px-4 py-1.5 font-[family-name:var(--font-display)] text-[13px] font-bold tracking-wide text-[color:var(--accent-ink)] transition-transform hover:scale-[1.03]"
        >
          + Create from a reel
        </Link>
      </div>

      {tab === "browse" ? (
        filtered.length === 0 ? (
          <p className="text-[color:var(--ink-dim)]">No formats match that search.</p>
        ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {filtered.map((f) => (
              <FormatCard key={f.id} format={f} />
            ))}
          </div>
        )
      ) : (
        <PastJobsList jobs={pastJobs} />
      )}
    </div>
  );
}

function HeartIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
      <path d="M12 21s-6.7-4.35-9.33-8.2C.94 10.2 1.4 6.9 4.1 5.1a5.2 5.2 0 0 1 7.1 1.2A5.2 5.2 0 0 1 18.3 5.1c2.7 1.8 3.16 5.1 1.43 7.7C18.7 16.65 12 21 12 21z" />
    </svg>
  );
}

function CommentIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
      <path d="M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H8.5L4 20.5V16H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
    </svg>
  );
}

/** Reel preview + hover-to-play — the video is decorative (muted, looped,
 *  no controls) so a click anywhere on it still bubbles up to the Card's
 *  own <Link>, keeping the whole card a single click-through target. Play
 *  starts on hover rather than autoplaying so 2 cards on screen at once
 *  isn't 2 simultaneous decodes running for no reason. */
function ReelPreview({ formatId }: { formatId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  return (
    <div
      onMouseEnter={() => {
        const v = videoRef.current;
        if (v) {
          v.currentTime = 0;
          v.play().catch(() => {});
        }
      }}
      onMouseLeave={() => {
        const v = videoRef.current;
        if (v) {
          v.pause();
          v.currentTime = 0;
        }
      }}
      className="relative aspect-[9/16] w-32 shrink-0 overflow-hidden rounded-xl bg-black/30 sm:w-36"
    >
      <video
        ref={videoRef}
        src={`/reels/${formatId}.mp4`}
        poster={`/reels/${formatId}.jpg`}
        muted
        loop
        playsInline
        preload="none"
        className="h-full w-full object-cover"
      />
    </div>
  );
}

function StatBlock({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-[color:var(--accent)]">{icon}</span>
      <div>
        <p className="font-[family-name:var(--font-display)] text-lg font-bold text-[color:var(--ink)]">
          {formatCount(value)}
        </p>
        <p className="text-[11px] tracking-wide text-[color:var(--ink-faint)] uppercase">{label}</p>
      </div>
    </div>
  );
}

function FormatCard({ format }: { format: FormatSummary }) {
  const reel = format.reel;
  return (
    <Card href={`/templates/${format.id}`} className="flex flex-col gap-5 p-6">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-[family-name:var(--font-display)] text-xl font-bold text-[color:var(--ink)]">
          {format.name}
        </h3>
        <Pill>{format.niche}</Pill>
      </div>

      {reel ? (
        <div className="flex gap-5">
          <ReelPreview formatId={format.id} />
          <div className="flex flex-1 flex-col justify-center gap-4">
            <StatBlock icon={<HeartIcon />} value={reel.likes} label="likes" />
            <StatBlock icon={<CommentIcon />} value={reel.comments} label="comments" />
          </div>
        </div>
      ) : (
        <>
          <p className="line-clamp-3 text-sm text-[color:var(--ink-dim)]">{format.description}</p>
          <div className="mt-auto flex flex-wrap gap-2 pt-2">
            <Pill>{format.blockCount} blocks</Pill>
            <Pill>{format.requiredSlots.length} slots to film</Pill>
            <Pill>~{format.estimatedMinutes} min</Pill>
          </div>
        </>
      )}
    </Card>
  );
}

const STATUS_LABEL = (job: JobSummary): string => {
  if (job.rendered) return "Rendered";
  if (job.completedStages.includes("edl")) return "Ready to edit";
  if (job.completedStages.length > 0) return "In progress";
  return "Draft";
};

function PastJobsList({ jobs }: { jobs: JobSummary[] }) {
  if (jobs.length === 0) {
    return <p className="text-[color:var(--ink-dim)]">Nothing here yet — start from a template to see it show up.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {jobs.map((job) => (
        <Card key={job.id} href={job.rendered ? `/jobs/${job.id}/edit` : `/jobs/${job.id}/resources`} className="flex items-center justify-between gap-4 p-5">
          <div>
            <p className="font-[family-name:var(--font-display)] font-bold text-[color:var(--ink)]">{job.id}</p>
            <p className="text-sm text-[color:var(--ink-dim)]">
              {job.formatId} · {new Date(job.createdAt).toLocaleString()}
            </p>
          </div>
          <Pill tone={job.rendered ? "accent" : "default"}>{STATUS_LABEL(job)}</Pill>
        </Card>
      ))}
    </div>
  );
}

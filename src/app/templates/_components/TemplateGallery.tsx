"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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

/** Bigger, more legible than the old 11px Pill-in-a-button (the redesign's
 *  whole point) — real button padding, a filled accent state, and a count
 *  so the filter's effect is visible before you click it. */
function NicheButton({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-5 py-2.5 font-[family-name:var(--font-display)] text-sm font-semibold tracking-wide capitalize transition-colors ${
        active
          ? "border-[color:var(--accent)] bg-[color:var(--accent)] text-[color:var(--accent-ink)]"
          : "border-white/15 text-[color:var(--ink-dim)] hover:border-white/30 hover:text-[color:var(--ink)]"
      }`}
    >
      {children} <span className="opacity-60">{count}</span>
    </button>
  );
}

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
      <div className="mb-8 flex flex-col gap-5 border-b border-white/10 pb-6">
        <div className="flex flex-wrap items-center gap-4">
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
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search niche or format…"
              className="min-w-[220px] flex-1 rounded-full border border-white/12 bg-transparent px-4 py-2 text-sm text-[color:var(--ink)] outline-none placeholder:text-[color:var(--ink-dim)] focus:border-[color:var(--accent)]"
            />
          )}
        </div>

        {/* Niche filter gets its own labeled row, in real buttons (not
            11px Pills) with counts — the old cramped-in-with-search Pill
            row was easy to miss entirely (the whole point of this redesign). */}
        {tab === "browse" && (
          <div>
            <p className="mb-2 font-[family-name:var(--font-display)] text-[11px] tracking-[0.2em] text-[color:var(--ink-dim)] uppercase">
              Niche
            </p>
            <div className="flex flex-wrap gap-2.5">
              <NicheButton active={niche === null} onClick={() => setNiche(null)} count={formats.length}>
                All
              </NicheButton>
              {niches.map((n) => (
                <NicheButton
                  key={n}
                  active={niche === n}
                  onClick={() => setNiche(n)}
                  count={formats.filter((f) => f.niche === n).length}
                >
                  {n}
                </NicheButton>
              ))}
            </div>
          </div>
        )}
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

function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5">
      <path
        d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Full-size lightbox for a reel, opened by ReelPreview's expand button.
 *  Rendered as a fixed overlay rather than routing anywhere — this is just
 *  a look, not a navigation. */
function ReelLightbox({ formatId, onClose }: { formatId: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-8 backdrop-blur-sm"
    >
      <div onClick={(e) => e.stopPropagation()} className="relative aspect-[9/16] h-[min(85vh,800px)]">
        <video
          src={`/reels/${formatId}.mp4`}
          poster={`/reels/${formatId}.jpg`}
          controls
          autoPlay
          loop
          playsInline
          className="h-full w-full rounded-xl bg-black object-contain"
        />
        <button
          onClick={onClose}
          aria-label="Close preview"
          className="absolute -top-3 -right-3 flex h-8 w-8 items-center justify-center rounded-full bg-white text-black shadow-lg transition-transform hover:scale-105"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

/** Reel preview + hover-to-play — the video is decorative (muted, looped,
 *  no controls) so a click anywhere on it still bubbles up to the Card's
 *  own onClick (starting the job), keeping the whole card a single
 *  click-through target. Play starts on hover rather than autoplaying so
 *  2 cards on screen at once isn't 2 simultaneous decodes running for no
 *  reason. The expand button is the one exception — it stops propagation
 *  so previewing the reel large doesn't also kick off a job. */
function ReelPreview({ formatId }: { formatId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [expanded, setExpanded] = useState(false);
  return (
    <>
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
        className="group relative aspect-[9/16] w-32 shrink-0 overflow-hidden rounded-xl bg-black/30 sm:w-36"
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
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/40 via-transparent to-transparent opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
        <button
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(true);
          }}
          aria-label="Preview reel"
          className="absolute top-2 right-2 z-10 flex h-7 w-7 items-center justify-center rounded-full border border-white/15 bg-black/40 text-white opacity-0 backdrop-blur-md transition-all duration-150 group-hover:opacity-100 hover:scale-105 hover:bg-black/60"
        >
          <ExpandIcon />
        </button>
      </div>
      {expanded && <ReelLightbox formatId={formatId} onClose={() => setExpanded(false)} />}
    </>
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

/** Clicking a card used to go to a /templates/[formatId] detail page with
 *  its own "Use this template" button — removed as an unnecessary extra
 *  step; this now does exactly what that button did (POST /api/jobs,
 *  then straight to the resources wizard), just triggered by the card
 *  itself. */
function FormatCard({ format }: { format: FormatSummary }) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reel = format.reel;

  const start = async () => {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ formatId: format.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "could not start");
      router.push(`/jobs/${data.jobId}/resources`);
    } catch (err) {
      setError((err as Error).message);
      setStarting(false);
    }
  };

  return (
    <Card
      onClick={start}
      className={`flex flex-col gap-5 p-6 ${starting ? "pointer-events-none opacity-60" : ""}`}
    >
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

      {starting && <p className="text-xs text-[color:var(--ink-dim)]">Starting…</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
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

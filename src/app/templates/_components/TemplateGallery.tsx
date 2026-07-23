"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Card, Pill } from "../../_components/ui";
import type { FormatSummary } from "../../lib/formats";
import type { JobSummary } from "../../lib/jobs";

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
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
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

function FormatCard({ format }: { format: FormatSummary }) {
  return (
    <Card href={`/templates/${format.id}`} className="flex flex-col gap-4 p-6">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-[family-name:var(--font-display)] text-xl font-bold text-[color:var(--ink)]">
          {format.name}
        </h3>
        <Pill>{format.niche}</Pill>
      </div>
      <p className="line-clamp-3 text-sm text-[color:var(--ink-dim)]">{format.description}</p>
      <div className="mt-auto flex flex-wrap gap-2 pt-2">
        <Pill>{format.blockCount} blocks</Pill>
        <Pill>{format.requiredSlots.length} slots to film</Pill>
        <Pill>~{format.estimatedMinutes} min</Pill>
      </div>
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

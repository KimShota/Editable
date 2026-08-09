"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ProjectSummary } from "../../lib/projects";

type Tab = "projects" | "trash";

/** 5872341 -> "5.6M", 490000 -> "478.5K" — matches how a file manager
 *  reports disk usage (binary units), not the decimal K/M used for social
 *  counts elsewhere in the app. */
const formatBytes = (bytes: number): string => {
  if (bytes <= 0) return "0B";
  const units = ["B", "K", "M", "G", "T"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)}${units[i]}`;
};

const formatDuration = (sec: number): string => {
  const total = Math.max(0, Math.round(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
      <circle cx="12" cy="5" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="12" cy="19" r="2" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5">
      <path
        d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClapperIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7 opacity-40">
      <path
        d="M3 9l1.5-4h15L18 9M3 9h18v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9zM6 5l2 4M11 5l2 4M16 5l2 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Full-width gradient banner, CapCut's own entry point into starting a
 *  new project — routes to /templates since a project here is only ever
 *  created by picking a format (see FormatCard's POST /api/jobs). */
function CreateProjectBanner() {
  return (
    <Link
      href="/templates"
      className="mb-10 flex h-28 items-center justify-center gap-3 rounded-2xl bg-[linear-gradient(120deg,var(--accent),var(--magenta))] font-[family-name:var(--font-display)] text-lg font-bold text-[color:var(--accent-ink)] transition-transform hover:scale-[1.01]"
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-black/15 text-2xl leading-none">+</span>
      Create project
    </Link>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-4 py-1.5 font-[family-name:var(--font-display)] text-[13px] tracking-wide transition-colors ${
        active
          ? "bg-[color:var(--accent)] text-[color:var(--accent-ink)]"
          : "text-[color:var(--ink-dim)] hover:text-[color:var(--ink)]"
      }`}
    >
      {children}
    </button>
  );
}

function useCloseOnOutsideClick(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [ref, onClose]);
}

function TileMenu({
  trashed,
  onRename,
  onTrash,
  onRestore,
  onDeleteForever,
  onClose,
}: {
  trashed: boolean;
  onRename: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onDeleteForever: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useCloseOnOutsideClick(ref, onClose);

  const itemClass =
    "block w-full px-3.5 py-2 text-left text-[13px] text-[color:var(--ink)] transition-colors hover:bg-white/8";

  return (
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      className="absolute top-9 right-2 z-10 w-40 overflow-hidden rounded-xl border border-[color:var(--card-border)] bg-[#1a1224] shadow-xl"
    >
      {trashed ? (
        <>
          <button className={itemClass} onClick={onRestore}>
            Restore
          </button>
          <button className={`${itemClass} text-red-400`} onClick={onDeleteForever}>
            Delete forever
          </button>
        </>
      ) : (
        <>
          <button className={itemClass} onClick={onRename}>
            Rename
          </button>
          <button className={`${itemClass} text-red-400`} onClick={onTrash}>
            Delete
          </button>
        </>
      )}
    </div>
  );
}

function ProjectTile({ project, onChanged }: { project: ProjectSummary; onChanged: () => void }) {
  const router = useRouter();
  const [thumbFailed, setThumbFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(project.name);
  const [busy, setBusy] = useState(false);

  const resumeHref = project.hasEdl ? `/jobs/${project.id}/edit` : `/jobs/${project.id}/resources`;

  const call = async (init: RequestInit & { permanent?: boolean } = {}) => {
    setBusy(true);
    try {
      const url = `/api/jobs/${project.id}/project${init.permanent ? "?permanent=1" : ""}`;
      await fetch(url, init);
      onChanged();
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const submitRename = async () => {
    const trimmed = draftName.trim();
    setRenaming(false);
    if (!trimmed || trimmed === project.name) return;
    await call({ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: trimmed }) });
  };

  return (
    <div
      onClick={() => !renaming && !busy && router.push(resumeHref)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (!renaming && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          router.push(resumeHref);
        }
      }}
      className={`group relative flex cursor-pointer flex-col gap-2 rounded-xl ${busy ? "pointer-events-none opacity-50" : ""}`}
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl border border-[color:var(--card-border)] bg-black/30">
        {!thumbFailed ? (
          <img
            src={`/api/jobs/${project.id}/thumbnail`}
            alt=""
            loading="lazy"
            onError={() => setThumbFailed(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <ClapperIcon />
          </div>
        )}

        <button
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          aria-label="Project options"
          className="absolute top-2 right-2 flex h-7 w-7 items-center justify-center rounded-full border border-white/15 bg-black/40 text-white opacity-0 backdrop-blur-md transition-opacity duration-150 group-hover:opacity-100 hover:bg-black/60"
        >
          <DotsIcon />
        </button>

        {menuOpen && (
          <TileMenu
            trashed={project.trashed}
            onClose={() => setMenuOpen(false)}
            onRename={() => {
              setMenuOpen(false);
              setDraftName(project.name);
              setRenaming(true);
            }}
            onTrash={() => {
              setMenuOpen(false);
              call({ method: "DELETE" });
            }}
            onRestore={() => {
              setMenuOpen(false);
              call({ method: "POST" });
            }}
            onDeleteForever={() => {
              setMenuOpen(false);
              if (window.confirm(`Delete "${project.name}" forever? This can't be undone.`)) {
                call({ method: "DELETE", permanent: true });
              }
            }}
          />
        )}
      </div>

      <div className="px-0.5">
        {renaming ? (
          <input
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={submitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(false);
            }}
            className="w-full rounded-md border border-[color:var(--accent)]/60 bg-black/30 px-1.5 py-0.5 text-sm font-bold text-[color:var(--ink)] outline-none"
          />
        ) : (
          <p className="truncate font-[family-name:var(--font-display)] text-sm font-bold text-[color:var(--ink)]">
            {project.name}
          </p>
        )}
        <p className="text-xs text-[color:var(--ink-dim)]">
          {formatBytes(project.sizeBytes)} | {project.durationSec != null ? formatDuration(project.durationSec) : "--:--"}
        </p>
      </div>
    </div>
  );
}

export function ProjectGrid({ projects }: { projects: ProjectSummary[] }) {
  const [tab, setTab] = useState<Tab>("projects");
  const [query, setQuery] = useState("");
  // Bumped after every mutation so tiles that render local UI state
  // (e.g. a just-closed rename input) don't need their own refetch —
  // router.refresh() re-runs the server component; this just forces
  // this component to drop any stale per-tile state on the next render.
  const [, forceTick] = useState(0);

  const active = projects.filter((p) => !p.trashed);
  const trashed = projects.filter((p) => p.trashed);
  const shown = (tab === "projects" ? active : trashed).filter((p) =>
    p.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div>
      <CreateProjectBanner />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-5">
        <div className="flex items-center gap-4">
          <h1 className="font-[family-name:var(--font-display)] text-2xl font-bold text-[color:var(--ink)]">
            Projects
          </h1>
          <div className="flex gap-1 rounded-full border border-white/10 p-1">
            <TabButton active={tab === "projects"} onClick={() => setTab("projects")}>
              All ({active.length})
            </TabButton>
            <TabButton active={tab === "trash"} onClick={() => setTab("trash")}>
              <span className="flex items-center gap-1.5">
                <TrashIcon /> Trash ({trashed.length})
              </span>
            </TabButton>
          </div>
        </div>

        <div className="relative">
          <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-[color:var(--ink-dim)]">
            <SearchIcon />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects…"
            className="w-56 rounded-full border border-white/12 bg-transparent py-2 pr-4 pl-9 text-sm text-[color:var(--ink)] outline-none placeholder:text-[color:var(--ink-dim)] focus:border-[color:var(--accent)]"
          />
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="text-[color:var(--ink-dim)]">
          {tab === "trash"
            ? "Trash is empty."
            : query
              ? "No projects match that search."
              : "Nothing here yet — start from a template to see it show up."}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {shown.map((p) => (
            <ProjectTile key={p.id} project={p} onChanged={() => forceTick((t) => t + 1)} />
          ))}
        </div>
      )}
    </div>
  );
}

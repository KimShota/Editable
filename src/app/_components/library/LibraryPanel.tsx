"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LIBRARY_CATEGORIES, LibraryAsset, LibraryCategory } from "../../lib/library-shared";
import { LIBRARY_DRAG_MIME } from "../../lib/dnd";

const CATEGORY_KIND: Record<LibraryCategory, "audio" | "image" | "video"> = {
  sfx: "audio",
  images: "image",
  gifs: "image",
  "screen-recordings": "video",
  music: "audio",
};

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

async function fetchAssets(): Promise<LibraryAsset[]> {
  const res = await fetch("/api/library");
  const data = await res.json();
  return data.assets ?? [];
}

export function LibraryPanel({
  variant = "page",
  allowDelete = variant === "page",
}: {
  variant?: "drawer" | "page";
  allowDelete?: boolean;
}) {
  const allowDuplicate = allowDelete;
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [category, setCategory] = useState<LibraryCategory>("sfx");
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    fetchAssets()
      .then(setAssets)
      .finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  const upload = async (files: FileList | File[]) => {
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.set("category", category);
        body.set("file", file);
        await fetch("/api/library", { method: "POST", body });
      }
      refresh();
    } finally {
      setUploading(false);
    }
  };

  const remove = async (asset: LibraryAsset) => {
    setAssets((prev) => prev.filter((a) => !(a.category === asset.category && a.filename === asset.filename)));
    await fetch(`/api/library/${asset.category}/${encodeURIComponent(asset.filename)}`, { method: "DELETE" });
  };

  const duplicate = async (asset: LibraryAsset) => {
    const res = await fetch(`/api/library/${asset.category}/${encodeURIComponent(asset.filename)}`, {
      method: "POST",
    });
    const data = await res.json();
    if (res.ok) setAssets((prev) => [data.asset, ...prev]);
  };

  const visible = assets.filter((a) => a.category === category);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap gap-1.5 border-b border-white/10 p-3">
        {LIBRARY_CATEGORIES.map((c) => (
          <button
            key={c.id}
            onClick={() => setCategory(c.id)}
            className={`rounded-full px-3 py-1 font-[family-name:var(--font-display)] text-[11px] tracking-wide transition-colors ${
              category === c.id
                ? "bg-[color:var(--accent)] text-[color:var(--accent-ink)]"
                : "border border-white/10 text-[color:var(--ink-dim)] hover:text-[color:var(--ink)]"
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="border-b border-white/10 p-3">
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && upload(e.target.files)}
        />
        <button
          onClick={() => fileInput.current?.click()}
          disabled={uploading}
          className="w-full rounded-lg border border-dashed border-white/20 py-2 text-xs text-[color:var(--ink-dim)] transition-colors hover:border-[color:var(--accent)]/50 hover:text-[color:var(--ink)] disabled:opacity-50"
        >
          {uploading ? "Uploading…" : `+ Add to ${LIBRARY_CATEGORIES.find((c) => c.id === category)?.label}`}
        </button>
      </div>

      <div className={`flex-1 overflow-y-auto p-3 ${variant === "page" ? "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" : "flex flex-col gap-2"}`}>
        {loading ? (
          <p className="text-xs text-[color:var(--ink-dim)]">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="text-xs text-[color:var(--ink-dim)]">Nothing here yet.</p>
        ) : (
          visible.map((asset) => (
            <LibraryAssetCard
              key={asset.filename}
              asset={asset}
              compact={variant === "drawer"}
              onDelete={allowDelete ? () => remove(asset) : undefined}
              onDuplicate={allowDuplicate ? () => duplicate(asset) : undefined}
            />
          ))
        )}
      </div>
    </div>
  );
}

function LibraryAssetCard({
  asset,
  compact,
  onDelete,
  onDuplicate,
}: {
  asset: LibraryAsset;
  compact: boolean;
  onDelete?: () => void;
  onDuplicate?: () => void;
}) {
  const kind = CATEGORY_KIND[asset.category];

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(
      LIBRARY_DRAG_MIME,
      JSON.stringify({ category: asset.category, filename: asset.filename, mediaUrl: asset.mediaUrl }),
    );
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      className={`group relative cursor-grab overflow-hidden rounded-lg border border-white/10 bg-white/[0.02] transition-colors hover:border-[color:var(--accent)]/50 active:cursor-grabbing ${
        compact ? "flex items-center gap-2 p-2" : "p-2"
      }`}
      title={asset.filename}
    >
      <div className={compact ? "h-9 w-9 shrink-0 overflow-hidden rounded" : "aspect-square overflow-hidden rounded bg-black/30"}>
        {kind === "image" ? (
          <img src={asset.mediaUrl} alt="" className="h-full w-full object-cover" />
        ) : kind === "video" ? (
          <video src={asset.mediaUrl} muted className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-lg">♪</div>
        )}
      </div>
      <div className={compact ? "min-w-0 flex-1" : "mt-1.5"}>
        <p className="truncate text-[11px] text-[color:var(--ink)]">{asset.filename}</p>
        {!compact && <p className="text-[10px] text-[color:var(--ink-dim)]">{formatBytes(asset.sizeBytes)}</p>}
      </div>
      {(onDuplicate || onDelete) && (
        <div className="absolute top-1 right-1 hidden gap-1 group-hover:flex">
          {onDuplicate && (
            <button
              onClick={onDuplicate}
              title="Duplicate"
              className="flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-[11px] text-white"
            >
              ⧉
            </button>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              title="Delete"
              className="flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-[11px] text-white"
            >
              ×
            </button>
          )}
        </div>
      )}
    </div>
  );
}

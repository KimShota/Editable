import fs from "node:fs";
import type { QueryFn } from "../../app/lib/db";
import type { Storage } from "../storage";
import { productionKeys } from "./keys";

/**
 * What a brand's videos cost to make (plan decision 15: the target is $3 a
 * video, and only a measured number can tell whether it is met). The
 * production CLI appends every paid call to videos/<card>/costs.jsonl; setup
 * and planning calls go to the cost_ledger table.
 */

export type CostEntry = { provider: string; operation: string; usd: number };

/** The per-video target (plan decision 15). */
export const TARGET_USD_PER_VIDEO = 3;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Every paid call recorded for one video. A half-written last line is skipped. */
export const readVideoCosts = async (storage: Storage, slug: string, cardId: string): Promise<CostEntry[]> => {
  const key = productionKeys(slug, cardId).costs;
  if (!(await storage.exists(key))) return [];
  const out: CostEntry[] = [];
  for (const line of fs.readFileSync(await storage.localPath(key), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      out.push({ provider: String(e.provider ?? "unknown"), operation: String(e.operation ?? "unknown"), usd: num(e.usd) });
    } catch {
      // not a complete entry yet
    }
  }
  return out;
};

export type CostBreakdown = { total: number; lines: { provider: string; operation: string; usd: number; calls: number }[] };

/** Totals, and the same by provider and operation, biggest first. */
export const summarizeCosts = (entries: CostEntry[]): CostBreakdown => {
  const by = new Map<string, { provider: string; operation: string; usd: number; calls: number }>();
  for (const e of entries) {
    const k = `${e.provider}\u0000${e.operation}`;
    const row = by.get(k) ?? { provider: e.provider, operation: e.operation, usd: 0, calls: 0 };
    row.usd += e.usd;
    row.calls += 1;
    by.set(k, row);
  }
  const lines = [...by.values()].sort((a, b) => b.usd - a.usd || a.provider.localeCompare(b.provider));
  return { total: entries.reduce((s, e) => s + e.usd, 0), lines };
};

/** What was spent on a brand outside any one video: reading its site,
 *  designing its character, planning, storyboards (cost_ledger rows). */
export const brandLedger = async (query: QueryFn, slug: string): Promise<CostBreakdown> => {
  const rows = await query(
    `select l.provider, l.operation, sum(l.usd)::float8 as usd, count(*)::int as calls
       from cost_ledger l join brands b on b.id = l.brand_id
      where b.slug = $1 group by l.provider, l.operation order by usd desc`,
    [slug],
  );
  const lines = rows.map((r) => ({ provider: String(r.provider), operation: String(r.operation), usd: num(r.usd), calls: Number(r.calls) }));
  return { total: lines.reduce((s, l) => s + l.usd, 0), lines };
};

/** Cost per produced video against the target. `videos` are those that have a
 *  cost log, so a brand with no produced video has no average, not a zero one. */
export const averageCost = (totals: number[]): { average: number | null; overTarget: boolean } => {
  if (totals.length === 0) return { average: null, overTarget: false };
  const average = totals.reduce((s, t) => s + t, 0) / totals.length;
  return { average, overTarget: average > TARGET_USD_PER_VIDEO };
};

const csvCell = (v: string | number): string => {
  const s = String(v);
  // A cell that starts with = + - @ would be run as a formula by a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(s) && typeof v === "string" ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** One row per paid call group per video, for the pitch's "measured cost per video". */
export const costCsv = (rows: { cardId: string; day: number; breakdown: CostBreakdown }[]): string => {
  const out = ["video,day,provider,operation,calls,usd"];
  for (const r of rows) for (const l of r.breakdown.lines) out.push([r.cardId, r.day, l.provider, l.operation, l.calls, l.usd.toFixed(4)].map(csvCell).join(","));
  out.push(["total", "", "", "", rows.reduce((s, r) => s + r.breakdown.lines.reduce((n, l) => n + l.calls, 0), 0), rows.reduce((s, r) => s + r.breakdown.total, 0).toFixed(4)].map(csvCell).join(","));
  return `${out.join("\n")}\n`;
};

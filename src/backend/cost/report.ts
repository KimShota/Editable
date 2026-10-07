/**
 * What one video cost, step by step, read from its costs.jsonl. Entries are
 * kept in the order the calls were made; the totals group them by step (the
 * entry's `operation`) and by provider. A call the provider could not price is
 * listed and flagged, never counted as a free call without saying so.
 */

export type LoggedCost = {
  at?: string;
  provider: string;
  model: string;
  operation: string;
  ref?: string;
  usd: number;
  units?: Record<string, number>;
  note?: string;
};

/** The entries of a costs.jsonl. A blank or half-written line is skipped. */
export const parseCostLog = (text: string): LoggedCost[] => {
  const out: LoggedCost[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      const usd = typeof e.usd === "number" && Number.isFinite(e.usd) ? e.usd : 0;
      out.push({
        at: typeof e.at === "string" ? e.at : undefined,
        provider: String(e.provider ?? "unknown"),
        model: String(e.model ?? ""),
        operation: String(e.operation ?? "unknown"),
        ref: typeof e.ref === "string" ? e.ref : undefined,
        usd,
        units: e.units && typeof e.units === "object" ? (e.units as Record<string, number>) : undefined,
        note: typeof e.note === "string" ? e.note : undefined,
      });
    } catch {
      // not a complete entry yet
    }
  }
  return out;
};

const money = (usd: number): string => `$${usd.toFixed(4)}`;

const group = (entries: LoggedCost[], key: (e: LoggedCost) => string) => {
  const by = new Map<string, { calls: number; usd: number }>();
  for (const e of entries) {
    const k = key(e);
    const row = by.get(k) ?? { calls: 0, usd: 0 };
    row.calls += 1;
    row.usd += e.usd;
    by.set(k, row);
  }
  return [...by.entries()].sort((a, b) => b[1].usd - a[1].usd || a[0].localeCompare(b[0]));
};

/** The printable report: every call in order, then totals by step and provider. */
export const costReport = (title: string, entries: LoggedCost[]): string => {
  if (entries.length === 0) return `${title}\n  no paid calls recorded`;
  const lines = [title, "", "every paid call, in order:"];
  for (const e of entries) {
    const when = e.at ? e.at.slice(11, 19) : "--:--:--";
    const unpriced = e.note ? "  (unpriced: " + e.note + ")" : "";
    lines.push(`  ${when}  ${money(e.usd).padStart(9)}  ${e.provider}/${e.operation}  ${e.model}${e.ref ? `  ${e.ref}` : ""}${unpriced}`);
  }
  const stepTable = (heading: string, rows: ReturnType<typeof group>) => {
    lines.push("", heading);
    for (const [k, r] of rows) lines.push(`  ${money(r.usd).padStart(9)}  ${String(r.calls).padStart(3)} call${r.calls === 1 ? " " : "s"}  ${k}`);
  };
  stepTable("by step:", group(entries, (e) => `${e.provider}/${e.operation}`));
  stepTable("by provider:", group(entries, (e) => e.provider));
  const unpriced = entries.filter((e) => e.note).length;
  lines.push("", `TOTAL ${money(entries.reduce((s, e) => s + e.usd, 0))} across ${entries.length} paid call${entries.length === 1 ? "" : "s"}`);
  if (unpriced) lines.push(`  ${unpriced} call${unpriced === 1 ? " has" : "s have"} no price, so the real total is higher: check the provider's dashboard`);
  return lines.join("\n");
};

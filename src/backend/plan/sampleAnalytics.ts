import type { Card } from "./schemas";

/**
 * Made-up numbers for the Analytics and Cycle Review screens, shown ONLY in
 * the founder's demo mode and always under a "Sample data" banner
 * (plan/ui-ux-full-flow.md §7). A customer's own login never sees these:
 * nobody has posted anything yet, and a number that is not theirs could be
 * screenshotted and forwarded. Deterministic from the card ids, so a demo
 * looks the same every time. Delete with the screens' shell state when real
 * metrics land (M3).
 */

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296; // 0..1
};

export type SampleVideo = {
  cardId: string;
  day: number;
  hook: string;
  platform: "TikTok" | "Instagram" | "YouTube";
  views48h: number;
  views7d: number;
  engagementRate: number;
  flag: "muted" | "claimed" | null;
};

export type SampleFormat = { sourceId: string; videos: number; avgViews7d: number; vsBaseline: number; verdict: "winner" | "loser" | "steady"; why: string };

export type SampleAnalytics = {
  videos: SampleVideo[];
  totalViews7d: number;
  avgEngagement: number;
  baselineViews7d: number;
  series: { day: number; views: number }[];
  formats: SampleFormat[];
  nextPlan: { winners: number; exploration: number };
};

const PLATFORMS = ["TikTok", "Instagram", "YouTube"] as const;
const WHY: Record<SampleFormat["verdict"], string> = {
  winner: "Viewers stayed through the hook and kept watching.",
  loser: "Many scrolled past in the first seconds.",
  steady: "Close to your usual numbers.",
};

export const sampleAnalytics = (cards: Pick<Card, "id" | "day" | "sourceId" | "hook" | "angle">[]): SampleAnalytics => {
  const chosen = [...cards].sort((a, b) => a.day - b.day).slice(0, 7);
  const videos: SampleVideo[] = chosen.map((c) => {
    const r = hash(c.id);
    const views7d = Math.round(1800 + r * 14000 + hash(c.sourceId) * 6000);
    return {
      cardId: c.id,
      day: c.day,
      hook: c.hook || c.angle,
      platform: PLATFORMS[Math.floor(hash(`${c.id}p`) * 3)],
      views48h: Math.round(views7d * (0.38 + hash(`${c.id}e`) * 0.2)),
      views7d,
      engagementRate: Math.round((2.2 + hash(`${c.id}r`) * 6.4) * 10) / 10,
      flag: hash(`${c.id}f`) > 0.93 ? (hash(`${c.id}g`) > 0.5 ? "muted" : "claimed") : null,
    };
  });

  const totalViews7d = videos.reduce((s, v) => s + v.views7d, 0);
  const baseline = videos.length ? Math.round(totalViews7d / videos.length) : 0;
  const bySource = new Map<string, SampleVideo[]>();
  for (const [i, v] of videos.entries()) bySource.set(chosen[i].sourceId, [...(bySource.get(chosen[i].sourceId) ?? []), v]);
  const formats: SampleFormat[] = [...bySource.entries()]
    .map(([sourceId, vs]) => {
      const avg = Math.round(vs.reduce((s, v) => s + v.views7d, 0) / vs.length);
      const vsBaseline = baseline ? Math.round((avg / baseline - 1) * 100) : 0;
      const verdict: SampleFormat["verdict"] = vsBaseline >= 10 ? "winner" : vsBaseline <= -10 ? "loser" : "steady";
      return { sourceId, videos: vs.length, avgViews7d: avg, vsBaseline, verdict, why: WHY[verdict] };
    })
    .sort((a, b) => b.vsBaseline - a.vsBaseline);

  return {
    videos,
    totalViews7d,
    avgEngagement: videos.length ? Math.round((videos.reduce((s, v) => s + v.engagementRate, 0) / videos.length) * 10) / 10 : 0,
    baselineViews7d: baseline,
    series: videos.map((v) => ({ day: v.day, views: v.views7d })),
    formats,
    nextPlan: { winners: 70, exploration: 30 },
  };
};

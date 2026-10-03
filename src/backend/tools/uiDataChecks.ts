import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasUnsafeSegment, isStorageKeySegment, safeDecode } from "../../app/lib/mediaPaths";
import { brandCostSink } from "../jobs/deps";
import { createPlanHandlers, directionFor } from "../jobs/planJobs";
import { createVideoHandlers } from "../jobs/videoJobs";
import { createNicheHandlers } from "../jobs/nicheJobs";
import { chooseNiche, NicheError } from "../niche/choose";
import { type NicheProposal, nicheProblems, withIds } from "../niche/propose";
import { readTakes } from "../production/takes";
import { artifactsDir, repoRoot } from "../pipeline/paths";
import { EdlSchema } from "../pipeline/schemas";
import { stubDeps } from "../jobs/stubs";
import { buildProposalText, pickAlternates, type PoolSource, type ProposeInput, proposalProblems } from "../plan/propose";
import { parseViralUrl } from "../recreation/viralUrl";
import { linkBrand } from "../brand/link";
import { cardHref, layoutCycle, summarizeCycle } from "../plan/calendar";
import { addDays, dateOfDay, daysBetween, formatDate, todayIn, weekdayIndex } from "../plan/dates";
import { BrandAccessError, BrandRepo } from "../brand/repo";
import { assertBrandSlug, brandKeys, parseVideoJobId, productionKeys, recreationKeys, videoJobId } from "../brand/keys";
import { type Card, CARD_STATUSES, PlanSchema } from "../plan/schemas";
import { allowedNext, canTransition, isEditable, isVideoVisible, MAX_HISTORY, statusLabel, TransitionError, transitionCard } from "../plan/status";
import { planFromFiles } from "../plan/seed";
import { findCard, sourceIdForCard } from "../plan/store";
import { runOnce, NO_CONTEXT } from "../queue/worker";
import { WorkQueue } from "../queue/workQueue";
import { LocalStorage } from "../storage";
import { makeChecker } from "./checks";
import { makeTestDb } from "./testDb";

/**
 * The data layer under the app's screens (brandRepo, the plan and its status
 * rules, task progress), with no network and no browser: PGlite with every
 * migration applied, and a temp directory as storage.
 *
 *   npm run test:ui-data
 *
 * Browser behaviour is covered separately by the Playwright smoke tests.
 */

const card = (over: Partial<Card> = {}): Card => ({
  id: "c1",
  day: 1,
  sourceId: "src1",
  angle: "an angle",
  hook: "a hook",
  status: "draft",
  lowConfidence: false,
  alternates: [],
  history: [],
  ...over,
});

const main = async () => {
  const t = makeChecker();

  console.log("keys");
  t.check("brand slug accepts lowercase and dashes", assertBrandSlug("shogun-ai") === "shogun-ai");
  for (const bad of ["Shogun", "../x", "a b", "", "-a", "a/b"]) t.throws(`brand slug rejects "${bad}"`, () => assertBrandSlug(bad), /lowercase slug/);
  t.check("brand keys live under brands/<slug>/", brandKeys("acme").plan === "brands/acme/plan.json" && brandKeys("acme").niche === "brands/acme/niche.json");
  t.check("a card's script and a source's spec are keyed separately", recreationKeys("acme").script("card-2") === "brands/acme/scripts/card-2.json" && recreationKeys("acme").spec("src") === "brands/acme/sources/specs/src.json");
  t.throws("a card id may not traverse", () => productionKeys("acme", "../x"), /card id/);
  t.check("production keys mint a fresh take each call", (() => { let n = 0; const k = productionKeys("acme", "c1", () => ++n); return k.take("s0") !== k.take("s0"); })());
  t.check("the video job id is brand-card", videoJobId("shogunai", "DbAJTxZtLAn") === "shogunai-DbAJTxZtLAn");
  t.check(
    "parseVideoJobId handles slugs with dashes by longest match",
    JSON.stringify(parseVideoJobId("shogun-ai-DbAJ", ["shogun", "shogun-ai"])) === JSON.stringify({ slug: "shogun-ai", cardId: "DbAJ" }),
  );
  t.check("parseVideoJobId is null for an unknown brand", parseVideoJobId("other-DbAJ", ["shogunai"]) === null);

  console.log("status rules");
  for (const s of CARD_STATUSES) t.check(`every status has a customer and admin label: ${s}`, !!statusLabel(s, "customer").label && !!statusLabel(s, "admin").label);
  t.check("customer approves a draft", canTransition("draft", "approved", "customer"));
  t.check("customer cannot release production", !canTransition("approved", "queued", "customer"));
  t.check("admin releases production", canTransition("approved", "queued", "admin"));
  t.check("only the system starts generating", canTransition("queued", "generating", "system") && !canTransition("queued", "generating", "admin") && !canTransition("queued", "generating", "customer"));
  t.check("customer cannot see a video before the admin sends it", !canTransition("internal_review", "needs_review", "customer") && canTransition("internal_review", "needs_review", "admin"));
  t.check("a thumbs-down sends a reviewed video back behind the gate", canTransition("needs_review", "internal_review", "customer"));
  t.check("customer approves a video, then marks it posted", canTransition("needs_review", "ready", "customer") && canTransition("ready", "posted", "customer"));
  t.check("a customer cannot jump a draft straight to ready", !canTransition("draft", "ready", "customer") && !canTransition("draft", "ready", "admin"));
  t.check("posted is final for a customer", allowedNext("posted", "customer").length === 0);
  t.check("failed goes back to the release gate only for an admin", allowedNext("failed", "admin").includes("approved") && allowedNext("failed", "customer").length === 0);
  t.check("the customer never sees the review gate or a failure", statusLabel("internal_review", "customer").label === "Generating" && statusLabel("failed", "customer").label === "Generating");
  t.check("the customer sees an approved card as queued for production", statusLabel("approved", "customer").label === "Queued for production");
  t.check("only a draft is editable", CARD_STATUSES.every((s) => isEditable(s) === (s === "draft")));
  {
    const moved = transitionCard(card(), "approved", "customer", new Date("2026-10-04T00:00:00Z"));
    t.check("transitionCard changes the status and records the move", moved.status === "approved" && moved.history.length === 1 && moved.history[0].from === "draft" && moved.history[0].by === "customer");
    t.check("transitionCard does not mutate its input", card().status === "draft");
    t.throws("transitionCard throws a TransitionError for a forbidden edge", () => transitionCard(card(), "ready", "customer"), /cannot move a card from draft to ready/);
    let flipped = card();
    for (let i = 0; i < MAX_HISTORY + 10; i++) flipped = transitionCard(flipped, flipped.status === "draft" ? "approved" : "draft", "customer");
    t.check("history is capped, keeping the newest", flipped.history.length === MAX_HISTORY);
    try {
      transitionCard(card(), "posted", "admin");
    } catch (err) {
      t.check("the error says what was attempted", err instanceof TransitionError && err.from === "draft" && err.to === "posted" && err.actor === "admin");
    }
  }
  {
    // Every edge named in allowedNext must also pass canTransition (the two
    // views of the table can't drift).
    let consistent = true;
    for (const from of CARD_STATUSES) for (const actor of ["customer", "admin", "system"] as const) for (const to of allowedNext(from, actor)) if (!canTransition(from, to, actor)) consistent = false;
    t.check("allowedNext and canTransition agree", consistent);
  }

  console.log("media path segments");
  for (const bad of ["..", ".", "", "../rival", "a/b", "a\\b", "x\0y"]) t.check(`an unsafe segment is flagged: ${JSON.stringify(bad)}`, hasUnsafeSegment([bad]));
  t.check("an ordinary file name is not flagged", !hasUnsafeSegment(["acme", "videos", "final v2.mp4", "résumé.png"]));
  t.check("one bad segment among good ones is caught", hasUnsafeSegment(["acme", "..", "rival"]));
  t.check("storage-key segments match what a brand's files are called", ["front.png", "s0-0.jpg", "DbAJTxZtLAn", "line-3.tts.mp3"].every(isStorageKeySegment));
  t.check("…and reject dotfiles, spaces and separators", [".env", "a b", "a/b", "..", "-x", ""].every((s) => !isStorageKeySegment(s)));
  t.check("safeDecode decodes, and returns null instead of throwing on a bad escape", safeDecode("a%2Fb") === "a/b" && safeDecode("%E0%A4%A") === null);

  console.log("viral link allow-list");
  for (const [url, clean] of [
    ["https://www.instagram.com/reel/DbAJTxZtLAn/?igsh=abc&utm=1", "https://www.instagram.com/reel/DbAJTxZtLAn/"],
    ["http://instagram.com/p/Abc-123/", "https://instagram.com/p/Abc-123/"],
    ["https://www.tiktok.com/@some.one/video/7123456789012345678?lang=en", "https://www.tiktok.com/@some.one/video/7123456789012345678"],
    ["https://vm.tiktok.com/ZMabc123/", "https://vm.tiktok.com/ZMabc123/"],
    ["https://www.youtube.com/shorts/aBc_dEf-123", "https://www.youtube.com/shorts/aBc_dEf-123"],
    ["https://youtu.be/aBc_dEf-123", "https://youtu.be/aBc_dEf-123"],
    ["  https://WWW.Instagram.com/reel/XyZ/  ", "https://www.instagram.com/reel/XyZ/"],
  ]) t.check(`accepts and cleans ${url}`, parseViralUrl(url) === clean);
  for (const bad of [
    "not a url", "", "ftp://instagram.com/reel/x/", "file:///etc/passwd", "javascript:alert(1)",
    "http://localhost/reel/x", "http://127.0.0.1/reel/x", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.5:8080/p/x",
    "https://evil.example/instagram.com/reel/x/", "https://instagram.com.evil.example/reel/x/", "https://notinstagram.com/reel/x/",
    "https://user:pass@www.instagram.com/reel/x/", "https://www.instagram.com:8443/reel/x/",
    "https://www.instagram.com/", "https://www.instagram.com/someprofile/", "https://www.youtube.com/watch?v=abc", "https://www.youtube.com/@channel",
  ]) t.throws(`rejects ${JSON.stringify(bad)}`, () => parseViralUrl(bad), /link|Paste|web|login|port/i);

  console.log("plan proposal rules");
  const pool: PoolSource[] = ["A", "B", "C"].map((id) => ({ sourceId: id, topic: `topic ${id}`, hook: `hook ${id}`, whyItWorks: "x", durationSec: 30, language: "en" }));
  const base: ProposeInput = { company: "Acme", product: { name: "Acme", oneLiner: "x", features: ["f"] }, audience: "all", language: "en", niche: null, sources: pool, freeDays: [1, 2, 3, 4, 5, 6], existing: [] };
  const good = { cards: [1, 2, 3, 4, 5, 6].map((day) => ({ day, sourceId: "ABC"[(day - 1) % 3], angle: `angle ${day}` })) };
  t.check("a clean proposal has no problems", proposalProblems(base, good).length === 0);
  const withCard = (i: number, patch: Partial<(typeof good.cards)[number]>) => ({ cards: good.cards.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  t.check("a day that is not free is flagged", proposalProblems(base, { cards: [...good.cards, { day: 9, sourceId: "A", angle: "late" }] }).some((p) => /day 9 is not a day to fill/.test(p)));
  t.check("a missing day is flagged", proposalProblems(base, { cards: good.cards.slice(0, 5) }).some((p) => /day 6 has no card/.test(p)));
  t.check("a repeated day is flagged", proposalProblems(base, { cards: [...good.cards, { day: 3, sourceId: "B", angle: "again" }] }).some((p) => /day 3 appears twice/.test(p)));
  t.check("a source that is not in the pool is flagged", proposalProblems(base, withCard(0, { sourceId: "ZZ" })).some((p) => /"ZZ" is not a source/.test(p)));
  t.check("an empty angle is flagged", proposalProblems(base, withCard(2, { angle: "   " })).some((p) => /angle is empty/.test(p)));
  t.check("the same angle twice is flagged, ignoring case and spacing", proposalProblems(base, withCard(4, { angle: "  ANGLE   1 " })).some((p) => /repeats the angle of day 1/.test(p)));
  t.check("an angle already in the plan is flagged", proposalProblems({ ...base, freeDays: [2], existing: [{ day: 1, sourceId: "A", angle: "angle 2" }] }, { cards: [{ day: 2, sourceId: "B", angle: "Angle 2" }] }).some((p) => /repeats the angle of day 1/.test(p)));
  t.check("the same source on neighbouring days is flagged", proposalProblems(base, withCard(1, { sourceId: "A" })).some((p) => /neighbouring day/.test(p)));
  t.check("…counting a day that is already planned", proposalProblems({ ...base, freeDays: [2], existing: [{ day: 1, sourceId: "B", angle: "old" }] }, { cards: [{ day: 2, sourceId: "B", angle: "new" }] }).some((p) => /neighbouring day/.test(p)));
  t.check("one format taking over the plan is flagged", proposalProblems({ ...base, freeDays: [1, 3, 5, 7, 9, 11] }, { cards: [1, 3, 5, 7, 9, 11].map((day) => ({ day, sourceId: "A", angle: `angle ${day}` })) }).some((p) => /used 6 times/.test(p)));
  t.check("a pool of one source may repeat (there is no choice)", proposalProblems({ ...base, sources: [pool[0]], freeDays: [1, 2] }, { cards: [{ day: 1, sourceId: "A", angle: "a" }, { day: 2, sourceId: "A", angle: "b" }] }).length === 0);
  t.check("the proposal text lists every source and day without reordering the input", (() => {
    const input: ProposeInput = { ...base, existing: [{ day: 5, sourceId: "A", angle: "x" }, { day: 2, sourceId: "B", angle: "y" }] };
    const text = buildProposalText(input);
    return text.includes("topic A") && text.includes("topic C") && text.includes("1, 2, 3, 4, 5, 6") && input.existing[0].day === 5;
  })());
  {
    const alts = pickAlternates(good.cards, pool);
    t.check("each card gets two alternates, never its own source", [...alts.entries()].every(([day, ids]) => ids.length === 2 && !ids.includes(good.cards[day - 1].sourceId)));
    t.check("alternates spread across the pool, not always the same two", new Set([...alts.values()].flat()).size === 3);
    t.check("a one-source pool has no alternates", [...pickAlternates([{ day: 1, sourceId: "A" }], [pool[0]]).values()][0].length === 0);
  }
  t.check("the direction for a card carries the angle and any note", directionFor("Be bold").includes("Be bold") && !directionFor("Be bold").includes("Note") && directionFor("Be bold", "shorter").includes("Note from the customer: shorter"));

  console.log("niche proposals");
  {
    const angle = (title: string, hooks: string[] = ["First hook.", "Second hook."]) => ({ title, whyItFits: "It fits.", exampleHooks: hooks });
    const ok: NicheProposal = { angles: [angle("Mac tips"), angle("Team mistakes"), angle("Customer questions"), angle("Behind the feature")] };
    t.check("a clean proposal has no problems", nicheProblems(ok).length === 0);
    t.check("fewer than 3 angles is refused", nicheProblems({ angles: ok.angles.slice(0, 2) }).some((p) => /expected 3 to 5/.test(p)));
    t.check("more than 5 angles is refused", nicheProblems({ angles: [...ok.angles, angle("Fifth"), angle("Sixth")] }).some((p) => /expected 3 to 5/.test(p)));
    t.check("two angles with the same title are refused, ignoring case and spacing", nicheProblems({ angles: [angle("Mac tips"), angle("  MAC   tips "), angle("Other")] }).some((p) => /both called/.test(p)));
    t.check("two titles that make the same id are refused", nicheProblems({ angles: [angle("Mac tips!"), angle("Mac tips?"), angle("Other")] }).some((p) => /same id/.test(p)));
    t.check("one hook is not enough, four is too many", nicheProblems({ angles: [angle("A", ["only one"]), angle("B"), angle("C")] }).some((p) => /2 or 3 example hooks/.test(p)) && nicheProblems({ angles: [angle("A", ["1", "2", "3", "4"]), angle("B"), angle("C")] }).some((p) => /2 or 3 example hooks/.test(p)));
    t.check("a repeated hook is refused", nicheProblems({ angles: [angle("A", ["Same.", " same. "]), angle("B"), angle("C")] }).some((p) => /repeats a hook/.test(p)));
    t.check("an empty title or reason is refused", nicheProblems({ angles: [{ ...angle("A"), title: "  " }, { ...angle("B"), whyItFits: "" }, angle("C")] }).length >= 2);
    t.check("an angle's id comes from its title", withIds({ angles: [angle("Mac shortcuts you did not know"), angle("What's new?!"), angle("日本語のタイトル")] }).map((a) => a.id).slice(0, 2).join() === "mac-shortcuts-you-did-not-know,whats-new");
  }

  console.log("plan dates");
  t.check("day 1 is the start date", dateOfDay("2026-10-09", 1) === "2026-10-09");
  t.check("day 14 is thirteen days later", dateOfDay("2026-10-09", 14) === "2026-10-22");
  t.check("addDays crosses a month and a year", addDays("2026-10-30", 3) === "2026-11-02" && addDays("2026-12-30", 3) === "2027-01-02");
  t.check("addDays handles a leap day", addDays("2028-02-28", 1) === "2028-02-29" && addDays("2027-02-28", 1) === "2027-03-01");
  t.check("daysBetween counts whole days, signed", daysBetween("2026-10-09", "2026-10-22") === 13 && daysBetween("2026-10-22", "2026-10-09") === -13 && daysBetween("2026-10-09", "2026-10-09") === 0);
  t.check("daysBetween is not thrown off by a daylight-saving change", daysBetween("2026-03-01", "2026-04-01") === 31 && daysBetween("2026-10-01", "2026-11-05") === 35);
  t.check("formatDate does not shift with the server's time zone", formatDate("2026-10-09") === "Oct 9" && formatDate("2026-10-09", { weekday: true }) === "Fri, Oct 9");
  t.check("weekdayIndex runs Monday=0 to Sunday=6", weekdayIndex("2026-10-05") === 0 && weekdayIndex("2026-10-09") === 4 && weekdayIndex("2026-10-11") === 6);
  t.throws("a malformed date is rejected", () => addDays("10/09/2026", 1), /YYYY-MM-DD/);
  t.throws("a date that does not exist is rejected", () => addDays("2026-02-31", 1), /not a real date/);
  t.check("todayIn uses the given time zone, not the server's", todayIn("Asia/Tokyo", new Date("2026-10-09T20:00:00Z")) === "2026-10-10" && todayIn("America/New_York", new Date("2026-10-09T20:00:00Z")) === "2026-10-09");

  console.log("who may see a produced video");
  for (const st of CARD_STATUSES) t.check(`customer visibility of a ${st} video`, isVideoVisible(st, false) === ["needs_review", "ready", "posted"].includes(st));
  t.check("an admin sees every video", CARD_STATUSES.every((st) => isVideoVisible(st, true)));
  t.check("the review gate hides a video that is still with the founder", !isVideoVisible("internal_review", false) && !isVideoVisible("generating", false) && !isVideoVisible("failed", false));

  console.log("calendar layout");
  {
    const mk = (days: number[], extra: Partial<Card> = {}) => days.map((day) => card({ id: `c${day}`, day, ...extra }));
    // 2026-10-09 is a Friday: four blank days (Mon to Thu), then the cycle.
    const fri = layoutCycle({ startsOn: "2026-10-09", cards: mk([1, 2, 3, 4, 5]) }, "2026-10-12");
    t.check("a Friday start spans three week-rows of seven", fri.length === 3 && fri.every((w) => w.length === 7));
    t.check("the days before the start are outside cells", fri[0].slice(0, 4).every((c) => c.kind === "outside") && fri[0][4].kind === "day");
    t.check("day 1 is on the Friday, and day 14 on a Thursday", (fri[0][4] as { day: number }).day === 1 && (fri[2][3] as { day: number; date: string }).day === 14 && (fri[2][3] as { date: string }).date === "2026-10-22");
    t.check("the days after the end are outside cells", fri[2].slice(4).every((c) => c.kind === "outside"));
    t.check("exactly 14 day cells", fri.flat().filter((c) => c.kind === "day").length === 14);
    t.check("a day with no card is an empty day, not missing", (fri[1][0] as { card: Card | null }).card?.id === "c4" && (fri[2][0] as { card: Card | null }).card === null);
    t.check("today is marked once, and past days before it", fri.flat().filter((c) => c.kind === "day" && c.today).length === 1 && (fri[0][4] as { past: boolean }).past && !(fri[1][1] as { past: boolean }).past);
    t.check("the cells are consecutive dates", (() => { const all = fri.flat(); return all.every((c, i) => i === 0 || addDays(all[i - 1].date, 1) === c.date); })());
    const mon = layoutCycle({ startsOn: "2026-10-05", cards: [] }, "2026-10-05");
    t.check("a Monday start fits exactly two weeks", mon.length === 2 && mon.flat().every((c) => c.kind === "day"));
    t.check("a Sunday start spans three rows, with six blank leading days", (() => { const w = layoutCycle({ startsOn: "2026-10-11", cards: [] }, "2026-10-11"); return w.length === 3 && w[0].slice(0, 6).every((c) => c.kind === "outside") && w[0][6].kind === "day"; })());
    t.check("a day when today is before the cycle has no today cell", layoutCycle({ startsOn: "2026-10-09", cards: [] }, "2026-10-01").flat().every((c) => c.kind === "outside" || !c.today));

    const sum = (today: string, cards: Card[] = []) => summarizeCycle({ startsOn: "2026-10-09", cards }, today);
    t.check("before the cycle it counts the days to the start", sum("2026-10-06").countdown === "Starts in 3 days" && sum("2026-10-08").countdown === "Starts in 1 day");
    t.check("during the first ten days it counts down to the next plan (day 11 is Oct 19)", sum("2026-10-09").countdown === "Next plan in 10 days" && sum("2026-10-18").countdown === "Next plan in 1 day");
    t.check("from day 11 the next plan is on its way", sum("2026-10-19").countdown === "Your next plan is on its way" && sum("2026-10-22").countdown === "Your next plan is on its way");
    t.check("after the last day the cycle has ended", sum("2026-10-23").countdown === "This cycle has ended");
    t.check("the end date is day 14", sum("2026-10-09").endsOn === "2026-10-22");
    t.check("ready counts approved and posted videos only", sum("2026-10-12", [card({ id: "a", day: 1, status: "ready" }), card({ id: "b", day: 2, status: "posted" }), card({ id: "c", day: 3, status: "needs_review" }), card({ id: "d", day: 4, status: "approved" })]).ready === 2);
    t.check("a card leads to the editor once it has a video, else to the plan", cardHref("x", true) === "/videos/x/edit" && cardHref("x", false) === "/plan/x");
  }

  console.log("plan schema");
  t.check("a plan with no niche or history parses with defaults", (() => {
    const p = PlanSchema.parse({ cycleId: "c1", startsOn: "2026-10-09", cards: [{ id: "a", day: 1, sourceId: "s", angle: "x", status: "draft" }] });
    return p.rev === 0 && p.niche === null && p.cards[0].alternates.length === 0 && p.cards[0].lowConfidence === false;
  })());
  t.throws("a card on day 15 is rejected", () => PlanSchema.parse({ cycleId: "c1", startsOn: "2026-10-09", cards: [{ id: "a", day: 15, sourceId: "s", angle: "x", status: "draft" }] }));
  t.throws("a bad start date is rejected", () => PlanSchema.parse({ cycleId: "c1", startsOn: "10/09/2026", cards: [] }));
  t.throws("an unknown status is rejected", () => PlanSchema.parse({ cycleId: "c1", startsOn: "2026-10-09", cards: [{ id: "a", day: 1, sourceId: "s", angle: "x", status: "done" }] }));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "katalab-ui-data-"));
  const { db, query } = await makeTestDb();
  try {
    const storage = new LocalStorage(root);
    const repo = new BrandRepo(query, storage);

    console.log("migrations 014-015");
    const cols = async (table: string) => (await query(`select column_name from information_schema.columns where table_name = $1`, [table])).map((r) => String(r.column_name));
    t.check("brands has a slug column", (await cols("brands")).includes("slug"));
    t.check("work_queue has a progress column", (await cols("work_queue")).includes("progress"));

    console.log("access: who can see which brand");
    const user = async (email: string, admin = false) => String((await query(`insert into users (email, email_norm, password_hash, is_admin) values ($1, $1, 'x', $2) returning id`, [email, admin]))[0].id);
    const toru = await user("toru@example.com");
    const other = await user("other@example.com");
    const founder = await user("founder@example.com", true);
    const ws = async (name: string, ...members: string[]) => {
      const id = String((await query(`insert into workspaces (name) values ($1) returning id`, [name]))[0].id);
      for (const m of members) await query(`insert into workspace_members (workspace_id, user_id) values ($1, $2)`, [id, m]);
      return id;
    };
    const wsA = await ws("Select", toru);
    const wsB = await ws("Other Co", other);
    const brand = async (workspaceId: string, name: string, slug: string | null) =>
      String((await query(`insert into brands (workspace_id, name, slug) values ($1, $2, $3) returning id`, [workspaceId, name, slug]))[0].id);
    await brand(wsA, "ShogunAI", "shogunai");
    await brand(wsB, "Rival", "rival");
    await brand(wsA, "Unlinked", null);

    const asToru = { id: toru, isAdmin: false };
    const asOther = { id: other, isAdmin: false };
    const asFounder = { id: founder, isAdmin: true };
    t.check("a member lists only their own workspace's linked brands", JSON.stringify((await repo.listBrandsForUser(asToru)).map((b) => b.slug)) === JSON.stringify(["shogunai"]));
    t.check("a brand with no slug is never listed", !(await repo.listBrandsForUser(asFounder)).some((b) => b.name === "Unlinked"));
    t.check("an admin lists every linked brand", (await repo.listBrandsForUser(asFounder)).map((b) => b.slug).sort().join() === "rival,shogunai");
    t.check("a member may open their brand", (await repo.assertAccess(asToru, "shogunai")).name === "ShogunAI");
    await t.rejects("a member may not open another workspace's brand", () => repo.assertAccess(asToru, "rival"), /no brand "rival"/);
    await t.rejects("a missing brand looks the same as a forbidden one", () => repo.assertAccess(asToru, "nope"), /no brand "nope"/);
    t.check("the access error is a BrandAccessError", await repo.assertAccess(asToru, "rival").then(() => false, (e) => e instanceof BrandAccessError));
    t.check("an admin may open any brand", (await repo.assertAccess(asFounder, "rival")).slug === "rival");
    t.check("another workspace's member sees only theirs", (await repo.listBrandsForUser(asOther)).map((b) => b.slug).join() === "rival");
    t.check("a user in no workspace sees nothing", (await repo.listBrandsForUser({ id: await user("loner@example.com"), isAdmin: false })).length === 0);
    t.check("hasBrand knows linked slugs only", (await repo.hasBrand("shogunai")) && !(await repo.hasBrand("ghost")));
    t.check("members of a brand's workspace are listed", (await repo.listMembers("shogunai")).map((m) => m.email).join() === "toru@example.com");
    t.check("the unique slug index rejects a duplicate", await query(`insert into brands (workspace_id, name, slug) values ($1, 'dup', 'shogunai')`, [wsB]).then(() => false, () => true));

    console.log("plan store: read, update, and concurrent writers");
    t.check("a brand with no plan reads null", (await repo.getPlan("shogunai")) === null);
    await t.rejects("updating a missing plan throws", () => repo.updatePlan("shogunai", (p) => p), /no plan yet/);
    const first = await repo.savePlan("shogunai", {
      cycleId: "c1",
      startsOn: "2026-10-09",
      niche: null,
      cards: [card({ id: "a", day: 1, sourceId: "srcA" }), card({ id: "b", day: 2, sourceId: "srcB" }), card({ id: "a-2", day: 3, sourceId: "srcA" })],
    });
    t.check("savePlan starts the revision at 0", first.rev === 0);
    t.check("the saved plan reads back", (await repo.getPlan("shogunai"))?.cards.length === 3);
    t.check("updatePlan bumps the revision", (await repo.updatePlan("shogunai", (p) => p)).rev === 1);
    t.check("two cards may share one source", (await repo.getPlan("shogunai"))!.cards.filter((c) => c.sourceId === "srcA").length === 2);
    t.check("a card's source is looked up through the plan", (await sourceIdForCard(storage, "shogunai", "a-2")) === "srcA");
    t.check("a card not in the plan is its own source (pre-card files)", (await sourceIdForCard(storage, "shogunai", "legacy")) === "legacy");
    t.check("a brand with no plan at all: card is its own source", (await sourceIdForCard(storage, "rival", "x")) === "x");

    await Promise.all(
      ["a", "b", "a-2", "a", "b"].map((id) => repo.updatePlan("shogunai", (p) => ({ ...p, cards: p.cards.map((c) => (c.id === id ? { ...c, angle: `${c.angle}+` } : c)) }))),
    );
    {
      const p = (await repo.getPlan("shogunai"))!;
      t.check("concurrent updates all land (none lost)", findCard(p, "a").angle === "an angle++" && findCard(p, "b").angle === "an angle++" && findCard(p, "a-2").angle === "an angle+");
      t.check("…and each bumped the revision once", p.rev === 6);
    }
    await t.rejects("an update that produces an invalid plan is rejected", () => repo.updatePlan("shogunai", (p) => ({ ...p, cards: [{ ...p.cards[0], day: 99 }] })));
    t.check("…and leaves the saved plan untouched", (await repo.getPlan("shogunai"))!.rev === 6);

    console.log("card transitions through the repo");
    await repo.transitionCard("shogunai", "a", "approved", "customer");
    t.check("approving moves the card and logs it", (await repo.getCard("shogunai", "a"))!.status === "approved" && (await repo.getCard("shogunai", "a"))!.history.length === 1);
    await t.rejects("a customer cannot release it", () => repo.transitionCard("shogunai", "a", "queued", "customer"), /cannot move a card/);
    await repo.transitionCard("shogunai", "a", "queued", "admin", { estimateUsd: 12.5 });
    t.check("a patch is applied with the move", (await repo.getCard("shogunai", "a"))!.estimateUsd === 12.5);
    await t.rejects("an unknown card throws instead of silently doing nothing", () => repo.transitionCard("shogunai", "zzz", "approved", "customer"), /no card zzz/);
    t.check("other cards were not touched", (await repo.getCard("shogunai", "b"))!.status === "draft");

    console.log("scripts, storyboards, post details, video");
    t.check("no script yet reads null", (await repo.getScript("shogunai", "a")) === null);
    t.check("no storyboard yet reads empty", (await repo.listStoryboard("shogunai", "a")).length === 0);
    await storage.putBuffer("brands/shogunai/storyboards/a/s0.png", Buffer.from("png"));
    await storage.putBuffer("brands/shogunai/storyboards/a/s2.png", Buffer.from("png"));
    await storage.putBuffer("brands/shogunai/storyboards/a/board.html", Buffer.from("<html>"));
    await storage.putBuffer("brands/shogunai/storyboards/a/footage/clip1.jpg", Buffer.from("jpg"));
    t.check("stills are listed per card, ignoring the board page and footage frames", (await repo.listStoryboard("shogunai", "a")).map((s) => s.shotId).join() === "s0,s2");
    t.check("another card's storyboard is separate", (await repo.listStoryboard("shogunai", "b")).length === 0);

    t.check("post details default to empty", (await repo.getPostDetails("shogunai", "a")).caption === "" && (await repo.getPostDetails("shogunai", "a")).hashtags.length === 0);
    await repo.savePostDetails("shogunai", "a", { caption: "hi", hashtags: ["ai"], platforms: ["tiktok"], postedUrls: ["https://tiktok.com/@x/video/1"] });
    t.check("post details persist", (await repo.getPostDetails("shogunai", "a")).postedUrls[0] === "https://tiktok.com/@x/video/1");
    await t.rejects("post details for a card not in the plan are refused", () => repo.savePostDetails("shogunai", "ghost", { caption: "", hashtags: [], platforms: [], postedUrls: [] }), /no card ghost/);
    await t.rejects("a bad posted URL is refused", () => repo.savePostDetails("shogunai", "a", { caption: "", hashtags: [], platforms: [], postedUrls: ["not a url"] }));

    t.check("a card with no video has no final and no cost", await repo.getVideo("shogunai", "b").then((v) => !v.hasFinal && v.costUsd === 0 && v.finalKey === null));
    await storage.putBuffer("brands/shogunai/videos/a/final.mp4", Buffer.from("mp4"));
    await storage.putBuffer("brands/shogunai/videos/a/costs.jsonl", Buffer.from(`${JSON.stringify({ usd: 1.5 })}\n${JSON.stringify({ usd: 0.25 })}\n{"usd": 9`));
    t.check("a video sums its cost log and ignores a half-written line", await repo.getVideo("shogunai", "a").then((v) => v.hasFinal && v.costUsd === 1.75));

    console.log("sources");
    t.check("an empty pool lists nothing", (await repo.listSources("shogunai")).length === 0);
    await storage.putBuffer("brands/shogunai/sources/abc.mp4", Buffer.from("v"));
    await storage.putBuffer("brands/shogunai/sources/abc.info.json", Buffer.from(JSON.stringify({ webpage_url: "https://x.test/abc", uploader: "someone", view_count: 10 })));
    await storage.putBuffer("brands/shogunai/sources/keyframes/abc/s0-0.jpg", Buffer.from("k"));
    {
      const [s] = await repo.listSources("shogunai");
      t.check("a source without a spec is listed from its info file", s.sourceId === "abc" && s.creator === "someone" && s.views === 10 && !s.hasSpec && s.thumbKey === null);
      t.check("keyframes are not mistaken for sources", (await repo.listSources("shogunai")).length === 1);
    }
    await storage.putBuffer("brands/shogunai/sources/abc-sheet.jpg", Buffer.from("j"));
    t.check("a contact sheet becomes the thumbnail", (await repo.listSources("shogunai"))[0].thumbKey === "brands/shogunai/sources/abc-sheet.jpg");

    console.log("linking a brand's files to a workspace");
    const intake = {
      companyName: "Acme",
      summary: "Snacks.",
      isMultiProduct: false,
      products: [{ name: "Crunch", oneLiner: "A snack.", type: "physical", url: null, features: ["crunchy"], priceNote: null, audience: "students", evidence: "hero" }],
      recommendedProductIndex: 0,
      recommendationReason: "only one",
      audience: "students",
      tone: ["fun"],
      language: "en",
      otherLanguages: [],
      brandKit: { primaryColor: "#ff6600", secondaryColor: null, accentColor: null, textColor: null, backgroundColor: null, headingFont: null, bodyFont: null, logoUrl: null },
      assets: [],
      gaps: [],
    };
    await t.rejects("linking a brand with no intake file is refused", () => linkBrand(query, storage, { slug: "acme" }), /no intake for acme/);
    await storage.putBuffer("brands/acme/intake.json", Buffer.from(JSON.stringify({ intake })));
    const linked = await linkBrand(query, storage, { slug: "acme", websiteUrl: "https://acme.test", memberEmails: ["toru@example.com", "nobody@example.com"] });
    t.check("a new link creates the workspace and brand", linked.created && !!linked.brandId && !!linked.workspaceId);
    t.check("an existing account is added as a member", linked.membersAdded.join() === "toru@example.com");
    t.check("an email with no account is reported, not an error", linked.missingEmails.join() === "nobody@example.com");
    t.check("the linked brand is visible to its member and not to others", (await repo.listBrandsForUser(asToru)).some((b) => b.slug === "acme") && !(await repo.listBrandsForUser(asOther)).some((b) => b.slug === "acme"));
    t.check("the brand row carries the slug, language and name", await repo.getBrand("acme").then((b) => b.slug === "acme" && b.language === "en" && b.name === "Crunch"));
    t.check("the intake reads back through the repo", (await repo.getIntake("acme"))?.companyName === "Acme");
    const again = await linkBrand(query, storage, { slug: "acme", memberEmails: ["toru@example.com", "other@example.com"] });
    t.check("linking again reuses the brand and adds only the new member", !again.created && again.brandId === linked.brandId && again.membersAdded.join() === "other@example.com");
    t.check("…without duplicating the product row", Number((await query(`select count(*)::int as n from products where brand_id = $1`, [linked.brandId]))[0].n) === 1);
    t.check("a bare intake.json (no wrapper) is accepted too", await (async () => {
      await storage.putBuffer("brands/bare/intake.json", Buffer.from(JSON.stringify(intake)));
      return (await linkBrand(query, storage, { slug: "bare" })).created;
    })());

    console.log("seeding a plan from the files on disk");
    const script = (id: string, angle: string, hook: string) => ({
      sourceId: id, brand: "acme", language: "en", angle, ctaKeyword: "GO",
      lines: [{ index: 0, text: hook, role: "hook", sourceText: "x", kept: false, shotIds: [], wordCount: 3, sourceWordCount: 3 }],
      shots: [], postCaption: "cap", hashtags: [], createdAt: "2026-10-03T00:00:00Z", model: "test",
    });
    await t.rejects("a brand with no scripts has nothing to seed", () => planFromFiles(storage, "acme", { startsOn: "2026-10-09" }), /no adapted scripts/);
    for (const [id, hook] of [["zeta", "Z hook"], ["alpha", "A hook"], ["mid", "M hook"]]) {
      await storage.putBuffer(`brands/acme/scripts/${id}.json`, Buffer.from(JSON.stringify(script(id, `angle ${id}`, hook))));
    }
    await storage.putBuffer("brands/acme/videos/zeta/final.mp4", Buffer.from("mp4"));
    const seeded = await planFromFiles(storage, "acme", { startsOn: "2026-10-09" });
    t.check("one card per script, card id = source id", seeded.cards.map((c) => c.id).sort().join() === "alpha,mid,zeta");
    t.check("a rendered video goes first, the rest by id", seeded.cards.map((c) => c.id).join() === "zeta,alpha,mid");
    t.check("days run 1..n in that order", seeded.cards.map((c) => c.day).join() === "1,2,3");
    t.check("a rendered video waits at the review gate; the rest are drafts", seeded.cards[0].status === "internal_review" && seeded.cards.slice(1).every((c) => c.status === "draft"));
    t.check("angle and hook come from the script", seeded.cards[0].angle === "angle zeta" && seeded.cards[0].hook === "Z hook");
    t.check("with no niche chosen the plan has none", seeded.niche === null);
    await storage.putBuffer("brands/acme/niche.json", Buffer.from(JSON.stringify({ angles: [{ id: "n1", title: "Study tips", whyItFits: "x", exampleHooks: [] }], chosenAngleId: "n1", proposedAt: "2026-10-03T00:00:00Z" })));
    t.check("a chosen niche is locked into the plan", (await planFromFiles(storage, "acme", { startsOn: "2026-10-09" })).niche?.title === "Study tips");
    t.check("the seeded plan is valid and saves", (await repo.savePlan("acme", seeded)).rev === 0);

    console.log("plan jobs with stub providers");
    // A brand of its own: the sections above already gave acme a plan.
    await storage.putBuffer("brands/planco/intake.json", Buffer.from(JSON.stringify({ intake })));
    await linkBrand(query, storage, { slug: "planco", websiteUrl: "https://planco.test" });
    await storage.putBuffer("brands/planco/character/character.json", Buffer.from("{}"));
    const deps = stubDeps({ query, storage, costSinkFor: (slug) => brandCostSink(query, slug) });
    const handlers = createPlanHandlers(deps);
    const run = (kind: string, payload: Record<string, unknown>) => handlers[kind]({ id: 1, kind, payload, attempts: 1, maxAttempts: 3 });
    const reports: string[] = [];
    const ctx = { report: (p: { stage: string }) => void reports.push(p.stage) };

    await t.rejects("planning with no viral sources is refused with a clear reason", () => run("plan.build", { slug: "planco" }), /no viral sources/);

    const urls = ["https://www.instagram.com/reel/AAA111/", "https://www.instagram.com/reel/BBB222/", "https://www.tiktok.com/@x/video/333"];
    for (const url of urls) await handlers["source.ingest"]({ id: 1, kind: "source.ingest", payload: { slug: "planco", url }, attempts: 1, maxAttempts: 3 }, ctx);
    t.check("ingesting downloads the video and builds its spec", (await repo.listSources("planco")).filter((x) => x.hasSpec).length === 3);
    t.check("ingest reported progress", reports.length > 0);
    await t.rejects("ingest re-checks the link even though the API did", () => run("source.ingest", { slug: "planco", url: "http://169.254.169.254/latest/meta-data/" }), /Paste a link/);
    await t.rejects("ingest refuses a payload with no brand", () => run("source.ingest", { url: urls[0] }));
    {
      const before = (await storage.list("brands/planco/sources")).length;
      await run("source.ingest", { slug: "planco", url: urls[0] });
      t.check("ingesting the same link twice adds nothing", (await storage.list("brands/planco/sources")).length === before);
    }

    const built = (await run("plan.build", { slug: "planco" })) as { added: number };
    const planA = (await repo.getPlan("planco"))!;
    t.check("a new brand gets a full 14-day plan", built.added === 14 && planA.cards.length === 14 && planA.cards.map((c) => c.day).join() === "1,2,3,4,5,6,7,8,9,10,11,12,13,14");
    t.check("every new card is a draft with a unique id", planA.cards.every((c) => c.status === "draft") && new Set(planA.cards.map((c) => c.id)).size === 14);
    t.check("no format is used on two neighbouring days", planA.cards.every((c, i) => i === 0 || c.sourceId !== planA.cards[i - 1].sourceId));
    t.check("the three formats are spread across the 14 days", [...new Set(planA.cards.map((c) => c.sourceId))].length === 3 && ["AAA111", "BBB222", "333"].every((id) => { const n = planA.cards.filter((c) => c.sourceId === id).length; return n >= 4 && n <= 6; }));
    t.check("each card offers two alternates, other than its own source", planA.cards.every((c) => c.alternates.length === 2 && c.alternates.every((a) => a.sourceId !== c.sourceId)));
    t.check("day 1 is tomorrow in the brand's time zone", planA.startsOn === addDays(todayIn("UTC"), 1) || planA.startsOn === addDays(todayIn("UTC"), 0) || planA.startsOn === addDays(todayIn("UTC"), 2));
    t.check("a card waits for its script: no hook yet", planA.cards.every((c) => c.hook === ""));
    const queued = await query(`select payload->>'cardId' as card, dedupe_key from work_queue where kind = 'card.adapt' and status = 'queued' and payload->>'slug' = 'planco'`);
    t.check("one adapt job per new card is queued, deduplicated", queued.length === 14 && new Set(queued.map((r) => r.dedupe_key)).size === 14);

    const firstCard = planA.cards[0];
    await run("card.adapt", { slug: "planco", cardId: firstCard.id });
    t.check("adapting writes the script under the card id and sets the hook", (await repo.getScript("planco", firstCard.id))?.lines.length === 3 && (await repo.getCard("planco", firstCard.id))!.hook.startsWith(`Hook for ${firstCard.id}`));
    t.check("the angle is passed to the writer as direction", (await repo.getScript("planco", firstCard.id))!.angle.includes(firstCard.angle.slice(0, 20)));
    await run("card.adapt", { slug: "planco", cardId: firstCard.id, note: "make it shorter" });
    t.check("a rewrite note reaches the writer", (await repo.getScript("planco", firstCard.id))!.lines[0].text.includes("make it shorter"));
    await repo.transitionCard("planco", firstCard.id, "approved", "customer");
    await t.rejects("an approved card cannot be rewritten", () => run("card.adapt", { slug: "planco", cardId: firstCard.id }), /only a draft can be rewritten/);
    await t.rejects("adapting a card that is not in the plan fails", () => run("card.adapt", { slug: "planco", cardId: "ghost" }), /no card ghost/);

    const second = planA.cards[1];
    await t.rejects("a storyboard needs a script first", () => run("card.storyboard", { slug: "planco", cardId: second.id }), /no script yet/);
    await run("card.adapt", { slug: "planco", cardId: second.id });
    const sb = (await run("card.storyboard", { slug: "planco", cardId: second.id }, )) as { generated: number };
    t.check("a storyboard makes one still per shot", sb.generated === 3 && (await repo.listStoryboard("planco", second.id)).length === 3);
    t.check("running it again redoes nothing", ((await run("card.storyboard", { slug: "planco", cardId: second.id })) as { generated: number }).generated === 0);

    const rebuilt = (await run("plan.build", { slug: "planco" })) as { added: number };
    t.check("planning again with a full plan adds nothing and keeps the cards", rebuilt.added === 0 && (await repo.getPlan("planco"))!.cards.length === 14);
    await repo.updatePlan("planco", (p) => ({ ...p, cards: p.cards.filter((c) => c.day <= 3) }));
    const filled = (await run("plan.build", { slug: "planco" })) as { added: number };
    const planB = (await repo.getPlan("planco"))!;
    t.check("planning with days already taken fills only the free ones", filled.added === 11 && planB.cards.length === 14 && planB.cards.slice(0, 3).every((c, i) => c.id === planA.cards[i].id));
    t.check("the existing cards, their status and the start date are untouched", planB.cards[0].status === "approved" && planB.startsOn === planA.startsOn);

    console.log("video jobs with the stub producer");
    const vh = createVideoHandlers(deps);
    const runV = (kind: string, payload: Record<string, unknown>) => vh[kind]({ id: 1, kind, payload, attempts: 1, maxAttempts: 1 });
    const vcards = (await repo.getPlan("planco"))!.cards;
    const target = vcards[1]; // has a script and a storyboard from above
    const jobDirOf = (id: string) => path.join(repoRoot, "jobs", `planco-${id}`);
    try {
      const est = (await runV("video.estimate", { slug: "planco", cardId: target.id })) as { usd: number; maxUsd: number };
      const priced = await repo.getCard("planco", target.id);
      t.check("an estimate is stored on the card, with its ceiling", est.usd === 12.5 && priced!.estimateUsd === 12.5 && priced!.estimateMaxUsd === 18);
      await t.rejects("an estimate needs a script", () => runV("video.estimate", { slug: "planco", cardId: vcards[5].id }), /no script yet/);

      await t.rejects("a draft is never produced", () => runV("video.produce", { slug: "planco", cardId: target.id }), /is draft, not queued/);
      await repo.transitionCard("planco", target.id, "approved", "customer");
      await t.rejects("an approved card the founder has not released is not produced either", () => runV("video.produce", { slug: "planco", cardId: target.id }), /is approved, not queued/);
      await repo.transitionCard("planco", target.id, "queued", "admin");
      const made = (await runV("video.produce", { slug: "planco", cardId: target.id })) as { flagged: string[] };
      const after = (await repo.getCard("planco", target.id))!;
      t.check("a released card ends at internal review, not at the customer", after.status === "internal_review" && made.flagged.length === 0 && !after.lowConfidence);
      t.check("the status history shows queued, generating, internal review", after.history.slice(-3).map((h) => h.to).join() === "queued,generating,internal_review");
      t.check("the finished video is stored with its cost log", (await repo.getVideo("planco", target.id)).hasFinal && (await repo.getVideo("planco", target.id)).costUsd > 0);
      const edl = EdlSchema.parse(JSON.parse(fs.readFileSync(path.join(artifactsDir(`planco-${target.id}`), "edl.json"), "utf8")));
      t.check("an EDL the editor can open is written, one segment per shot", edl.video.length === 3 && edl.durationSec === 6 && Object.keys(edl.assets).length === 3);
      t.check("every clip file in the EDL exists", Object.values(edl.assets).every((f) => fs.existsSync(f) && fs.statSync(f).size > 500));
      t.check("the editor's job folder says which brand video it is", JSON.parse(fs.readFileSync(path.join(jobDirOf(target.id), "ai-video.json"), "utf8")).brand === "planco");
      t.check("each shot has its first take", Object.keys(readTakes(`planco-${target.id}`)).length === 3 && Object.values(readTakes(`planco-${target.id}`)).every((x) => x.takes.length === 1));

      const clipId = edl.video[0].id;
      await runV("clip.regenerate", { slug: "planco", cardId: target.id, clipId });
      t.check("regenerating a clip adds a take and keeps the old one", readTakes(`planco-${target.id}`)[edl.video[0].blockId].takes.length === 2);
      await t.rejects("regenerating needs a real card", () => runV("clip.regenerate", { slug: "planco", cardId: "ghost", clipId }), /no card ghost/);
      await t.rejects("a hostile clip id is refused", () => runV("clip.regenerate", { slug: "planco", cardId: target.id, clipId: "../../etc" }));

      // A run that fails leaves the card failed, with the reason, and is not retried.
      const broken = vcards[6];
      await repo.transitionCard("planco", broken.id, "approved", "customer");
      await repo.transitionCard("planco", broken.id, "queued", "admin");
      await t.rejects("a run that fails reports why", () => runV("video.produce", { slug: "planco", cardId: broken.id }), /ENOENT|no adapted script|adapted script/);
      t.check("…and the card is marked failed, not left generating", (await repo.getCard("planco", broken.id))!.status === "failed");
      t.check("a failed card can be released again by the founder only", canTransition("failed", "queued", "admin") && !canTransition("failed", "queued", "customer"));

      // A shot that only passed on its last retry flags the card.
      await run("card.adapt", { slug: "planco", cardId: vcards[7].id });
      await repo.updatePlan("planco", (p) => ({ ...p, cards: p.cards.map((c) => (c.id === vcards[7].id ? { ...c, id: `${c.id}-flag` } : c)) }));
      const flagId = `${vcards[7].id}-flag`;
      await storage.putBuffer(`brands/planco/scripts/${flagId}.json`, fs.readFileSync(await storage.localPath(`brands/planco/scripts/${vcards[7].id}.json`)));
      await repo.transitionCard("planco", flagId, "approved", "customer");
      await repo.transitionCard("planco", flagId, "queued", "admin");
      await runV("video.produce", { slug: "planco", cardId: flagId });
      t.check("a shot that passed only on its last retry raises the low-confidence flag", (await repo.getCard("planco", flagId))!.lowConfidence === true);
    } finally {
      for (const entry of fs.readdirSync(path.join(repoRoot, "jobs")).filter((n) => n.startsWith("planco-"))) fs.rmSync(path.join(repoRoot, "jobs", entry), { recursive: true, force: true });
      for (const base of ["artifacts", "public/jobs"]) {
        const dir = path.join(repoRoot, base);
        if (fs.existsSync(dir)) for (const entry of fs.readdirSync(dir).filter((n) => n.startsWith("planco-"))) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
      }
    }

    console.log("niche: propose, choose, and the cycle lock");
    const nh = createNicheHandlers(deps);
    const runN = (payload: Record<string, unknown>) => nh["niche.propose"]({ id: 1, kind: "niche.propose", payload, attempts: 1, maxAttempts: 1 });
    await t.rejects("proposing for a brand with no intake is refused", () => runN({ slug: "ghostbrand" }), /intake|ENOENT|no brand intake/);
    t.check("a brand has no niche before it is proposed", (await repo.getNiche("planco")) === null);
    await t.rejects("choosing before any are proposed says so", () => chooseNiche(storage, "planco", "x"), /no angles to choose from/);
    t.check("proposing saves 4 distinct angles with ids and no pick", ((await runN({ slug: "planco" })) as { angles: number }).angles === 4 && (await repo.getNiche("planco"))!.angles.length === 4 && (await repo.getNiche("planco"))!.chosenAngleId === null);
    const angles = (await repo.getNiche("planco"))!.angles;
    await t.rejects("an angle that was not proposed cannot be chosen", () => chooseNiche(storage, "planco", "made-up"), /not one of the proposed/);
    t.check("choosing records the pick and locks it into the plan", await (async () => {
      const chosen = await chooseNiche(storage, "planco", angles[0].id);
      const plan = (await repo.getPlan("planco"))!;
      return chosen.angleId === angles[0].id && (await repo.getNiche("planco"))!.chosenAngleId === angles[0].id && plan.niche?.angleId === angles[0].id && plan.niche.title === angles[0].title;
    })());
    t.check("choosing the same angle again is harmless", (await chooseNiche(storage, "planco", angles[0].id)).angleId === angles[0].id);
    await t.rejects("a different angle is refused: the niche is locked for the cycle", () => chooseNiche(storage, "planco", angles[1].id), /locked for this cycle/);
    t.check("the refusal is a NicheError", await chooseNiche(storage, "planco", angles[1].id).then(() => false, (e) => e instanceof NicheError));
    await t.rejects("proposing again is refused once the plan carries a niche", () => runN({ slug: "planco" }), /locked for this cycle/);
    t.check("the locked niche and pick are untouched", (await repo.getNiche("planco"))!.chosenAngleId === angles[0].id);
    // Before a plan exists, a pick just waits for it.
    await storage.putBuffer("brands/nichecase/intake.json", Buffer.from(JSON.stringify({ intake })));
    await runN({ slug: "nichecase" });
    const early = (await repo.getNiche("nichecase"))!.angles;
    await chooseNiche(storage, "nichecase", early[2].id);
    t.check("a pick made before a plan exists is kept for it", (await repo.getNiche("nichecase"))!.chosenAngleId === early[2].id && (await repo.getPlan("nichecase")) === null);
    await runN({ slug: "nichecase" });
    t.check("proposing again keeps the pick, because that angle is still proposed", (await repo.getNiche("nichecase"))!.chosenAngleId === early[2].id);

    console.log("task progress on the queue");
    const q = new WorkQueue(query);
    const id = (await q.enqueue("demo.kind", { slug: "shogunai", cardId: "a" }))!;
    t.check("a queued task reads as queued with no progress", await q.getTask(id).then((x) => x?.status === "queued" && x.progress === null));
    t.check("an unknown task reads null", (await q.getTask(999999)) === null);
    const job = (await q.claim("w1", ["demo.kind"]))!;
    t.check("a worker that holds the job may report progress", await q.setProgress(job, "w1", { stage: "frames", done: 2, total: 7, message: "shot 2" }));
    t.check("another worker may not", !(await q.setProgress(job, "w2", { stage: "evil" })));
    t.check("progress reads back through getTask", await q.getTask(id).then((x) => x?.status === "running" && x.progress?.done === 2 && x.progress.total === 7 && x.progress.message === "shot 2"));
    await q.complete(job, "w1", { ok: true });
    t.check("a finished task reads as done with its result", await q.getTask(id).then((x) => x?.status === "done" && (x.result as { ok: boolean }).ok && x.error === null));

    const failing = (await q.enqueue("demo.fail", { slug: "shogunai", cardId: "b" }, { maxAttempts: 1 }))!;
    await runOnce({ queue: q, workerId: "w3", handlers: { "demo.fail": async () => { throw new Error("boom"); } } });
    t.check("a task that exhausts its attempts reads as failed with the error", await q.getTask(failing).then((x) => x?.status === "failed" && /boom/.test(x.error ?? "")));

    await q.enqueue("demo.report", { slug: "shogunai", cardId: "a" });
    let seen: { stage?: string; done?: number; total?: number } | null = null;
    await runOnce({
      queue: q,
      workerId: "w4",
      handlers: {
        "demo.report": async (j, ctx) => {
          (ctx ?? NO_CONTEXT).report({ stage: "working", done: 1, total: 2 });
          await new Promise((r) => setTimeout(r, 50));
          seen = (await q.getTask(j.id))?.progress ?? null;
        },
      },
    });
    t.check("the worker gives a handler a working reporter", seen !== null && (seen as { stage?: string }).stage === "working" && (seen as { done?: number }).done === 1 && (seen as { total?: number }).total === 2);
    t.check("a handler called without a worker can still report (no-op)", (() => { NO_CONTEXT.report({ stage: "x" }); return true; })());

    await q.enqueue("demo.kind", { slug: "rival", cardId: "z" });
    await q.enqueue("other.kind", { slug: "shogunai", cardId: "a" });
    const active = await q.listTasks({ slug: "shogunai" });
    t.check("listTasks is scoped to the brand and returns live tasks only", active.length === 1 && active[0].kind === "other.kind");
    t.check("…recent finished tasks are included on request", (await q.listTasks({ slug: "shogunai", includeRecentMinutes: 5 })).length >= 4);
    t.check("…and can be narrowed by kind and card", (await q.listTasks({ slug: "shogunai", kinds: ["demo.kind"], cardId: "a", includeRecentMinutes: 5 })).every((x) => x.kind === "demo.kind"));
    t.check("a failed task is not listed as active", !(await q.listTasks({ slug: "shogunai" })).some((x) => x.id === failing));
  } finally {
    await db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  t.finish("ui-data checks");
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

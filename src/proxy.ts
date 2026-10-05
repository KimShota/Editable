import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, SESSION_COOKIE } from "./app/lib/session";
import { query, sql } from "./app/lib/db";
import { brandSlugForVideoJob, findBrandForViewer } from "./backend/brand/access";
import { isBrandSlug } from "./backend/brand/keys";
import { isVideoVisible } from "./backend/plan/status";
import { readPlan } from "./backend/plan/store";
import { getStorage } from "./backend/storage";
import { safeDecode } from "./app/lib/mediaPaths";

/**
 * The request proxy (Next 16 renamed this file convention from
 * `middleware`; see node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/proxy.md). It runs in the Node.js runtime by default,
 * which the plain node:crypto + @neondatabase/serverless calls in
 * session.ts/db.ts need, and which matches this app's actual deploy target
 * (a persistent Node server, not Vercel Edge Functions; see the
 * friends-alpha deploy plan). Setting a `runtime` export here would throw.
 *
 * This file was `src/middleware.ts`: comments elsewhere in the repo that say
 * "middleware.ts" mean this file.
 */

/**
 * Accounts + job ownership. Invite-gated signup
 *    (see app/lib/auth.ts) means every non-public route requires a valid
 *    session; /jobs/<id>, /api/jobs/<id>, and the media routes that serve
 *    a job's own files additionally require OWNING that job (or being
 *    admin) — jobs contain friends' personal footage, so this isn't
 *    optional. /authoring, /api/authoring, /reverse-engineer, and the
 *    authoring media root are admin-only: authoring runs yt-dlp against
 *    any URL a visitor types and spends LLM credits, not something to
 *    expose to every signed-up friend.
 *
 * Allow-list, not deny-list, same as before: anything not explicitly
 * public 401s/redirects, so a new route added later is protected by
 * default instead of accidentally exposed because nobody remembered it.
 *
 * A job with no job_owners row is admin-only UNLESS it's one of the three
 * ids checked into the repo as genuine shared example content (see
 * .gitignore's explicit `!jobs/<id>` allow-list) — everything else unowned
 * is real dev/test data that predates accounts, not something to expose to
 * every signed-up friend by default. Kept in sync with jobs.ts's copy of
 * this same list. Being shared doesn't mean writable, though: a demo job
 * is read-only for non-admins (GET/HEAD only) — otherwise any tester could
 * overwrite or "Delete forever" the one demo every gallery preview and
 * README walkthrough points at.
 *
 * Each user's own asset library (library/<userId>/<category>/, see
 *    app/lib/library.ts) is scoped the same way a job is — every route
 *    under api/library/ already resolves to the caller's own userId
 *    server-side, so the only extra thing middleware needs to enforce is
 *    that /api/media/library/<userId>/... can't be fetched by anyone but
 *    that userId (or an admin).
 */

const PUBLIC_EXACT = new Set(["/", "/login", "/signup", "/pricing"]);
// /api/billing/webhook: Stripe can't send our session cookie — its own
// signature check (see that route) is the auth boundary, not this gate.
// /api/leads and /landing/: the marketing page's lead form and its reel videos, visited before any login.
const PUBLIC_PREFIXES = ["/api/auth/", "/api/billing/webhook", "/api/leads", "/landing/"];

const ADMIN_PREFIXES = ["/authoring", "/api/authoring", "/reverse-engineer", "/api/media/authoring", "/admin", "/api/admin"];

const isApiPath = (pathname: string): boolean => pathname.startsWith("/api/");

/** Extracts a job id from any URL shape that names one:
 *  /jobs/<id>/... (page, and also where staged preview thumbnails under
 *  public/jobs/<id>/... are served from — see previewAssets.ts),
 *  /api/jobs/<id>/..., /api/media/jobs/<id>/... (uploaded assets),
 *  /api/media/out/<id>.mp4 (the rendered download), and
 *  /api/media/public-jobs/<id>/... — the destination next.config.mjs's
 *  afterFiles rewrite sends stale-public-snapshot requests to (see that
 *  rewrite's comment). The rewrite only ever fires from an already-checked
 *  /jobs/<id>/... request (caught by the first pattern below), but this
 *  route is reachable directly too, and without its own pattern here that
 *  direct hit would skip ownership entirely — jobId comes back null, so
 *  the `if (jobId)` check in the caller never runs. Bare /api/jobs
 *  (list/create) has no single job to own yet, so it's deliberately not
 *  matched here — listJobs() itself filters by owner (see app/lib/jobs.ts). */
const jobIdFromPath = (pathname: string): string | null => {
  const patterns = [
    /^\/jobs\/([^/]+)/,
    /^\/api\/jobs\/([^/]+)/,
    /^\/api\/media\/jobs\/([^/]+)/,
    /^\/api\/media\/public-jobs\/([^/]+)/,
    /^\/api\/media\/out\/([^/]+)\.mp4$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(pathname);
    if (match) return match[1];
  }
  return null;
};

/** Extracts the owning userId from a library media path:
 *  /api/media/library/<userId>/<category>/<filename>. Distinct from
 *  jobIdFromPath — a library asset's "owner" is baked directly into the
 *  URL (see lib/library.ts's mediaUrlFor), not looked up in a table. */
const libraryUserIdFromPath = (pathname: string): string | null => {
  const match = /^\/api\/media\/library\/([^/]+)\//.exec(pathname);
  return match ? match[1] : null;
};

/**
 * In-process cache for jobOwnerId, same motivation as session.ts's
 * sessionCache (a Neon round trip measured ~90ms, and this runs on every
 * request naming a job — every clip, thumbnail, and Range-seek included).
 *
 * A positive hit is cached WITHOUT expiry: job_owners is insert-only (see
 * createJob/jobs.ts — no update or delete path touches it), so once a
 * jobId maps to an ownerId that mapping is true for the life of the
 * process. A miss (no row yet) gets a short TTL instead of the same
 * treatment, because createJob writes the job's directory to disk
 * (jobExists() sees it immediately) BEFORE its `insert into job_owners`
 * resolves — caching that brief gap's "no owner" indefinitely would lock a
 * user out of the job they just created until the process restarts.
 */
const jobOwnerCache = new Map<string, { ownerId: string | null; expiresAt: number }>();
const JOB_OWNER_CACHE_MISS_TTL_MS = 5_000;

/** null means no owner is recorded for this job (legacy/demo content). */
const jobOwnerId = async (jobId: string): Promise<string | null> => {
  const cached = jobOwnerCache.get(jobId);
  if (cached && cached.expiresAt > Date.now()) return cached.ownerId;

  const rows = await sql`select user_id from job_owners where job_id = ${jobId}`;
  const ownerId = (rows[0] as { user_id: string } | undefined)?.user_id ?? null;

  jobOwnerCache.set(jobId, { ownerId, expiresAt: ownerId !== null ? Infinity : Date.now() + JOB_OWNER_CACHE_MISS_TTL_MS });
  return ownerId;
};

/** Extracts the brand slug from a URL that names one:
 *  /api/media/brands/<slug>/... (that brand's character sheet, storyboards,
 *  source videos, finished video) and /api/brands/<slug>/... (its API).
 *
 *  Returns null when the URL names no brand, and "" when it names something
 *  that is not a valid slug (so the caller denies it). The segment is
 *  URL-decoded first: the route handler decodes it, so authorising the raw
 *  text would authorise something other than what gets served. */
const brandSlugFromPath = (pathname: string): string | null => {
  const match = /^\/api\/(?:media\/)?brands\/([^/]+)\//.exec(pathname);
  if (!match) return null;
  const decoded = safeDecode(match[1]);
  return decoded !== null && isBrandSlug(decoded) ? decoded : "";
};

/**
 * Whether a user may open a brand (workspace membership; see
 * backend/brand/access.ts). Cached in-process like the session and job-owner
 * lookups above, for the same reason (this runs on every image and video
 * range request of a brand page). A positive hit lasts 30s, so removing a
 * member takes effect within that; a miss lasts 5s so a member added a
 * moment ago isn't locked out.
 */
const brandAccessCache = new Map<string, { ok: boolean; expiresAt: number }>();
const BRAND_ACCESS_HIT_TTL_MS = 30_000;
const BRAND_ACCESS_MISS_TTL_MS = 5_000;

const canOpenBrand = async (user: { id: string; isAdmin: boolean }, slug: string): Promise<boolean> => {
  const cacheKey = `${user.id}:${slug}`;
  const cached = brandAccessCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.ok;
  let ok = false;
  try {
    ok = (await findBrandForViewer(query, user, slug)) !== null;
  } catch (err) {
    // Fail closed. The usual cause is a database that has not had the brand
    // migrations applied yet (brands.slug, migration 014): that must deny the
    // brand's files, not turn every request that reaches this check into a 500.
    console.error("proxy: brand access lookup failed; denying", err);
  }
  brandAccessCache.set(cacheKey, { ok, expiresAt: Date.now() + (ok ? BRAND_ACCESS_HIT_TTL_MS : BRAND_ACCESS_MISS_TTL_MS) });
  return ok;
};

/**
 * Whether this user may see a card's produced video. Customers only see one
 * after the founder has sent it through the review gate (plan/status.ts); the
 * card ids are visible in their plan, so without this a hidden video's files
 * could be fetched by URL. Reads plan.json (a few seconds of cache) and fails
 * closed.
 */
const videoVisibilityCache = new Map<string, { visible: boolean; expiresAt: number }>();
const VIDEO_VISIBILITY_TTL_MS = 3_000;

const canSeeVideo = async (user: { isAdmin: boolean }, slug: string, cardId: string): Promise<boolean> => {
  if (user.isAdmin) return true;
  const cacheKey = `${slug}:${cardId}`;
  const cached = videoVisibilityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.visible;
  let visible = false;
  try {
    const card = (await readPlan(getStorage(), slug))?.cards.find((c) => c.id === cardId);
    visible = card ? isVideoVisible(card.status, false) : false;
  } catch (err) {
    console.error("proxy: video visibility lookup failed; denying", err);
  }
  videoVisibilityCache.set(cacheKey, { visible, expiresAt: Date.now() + VIDEO_VISIBILITY_TTL_MS });
  return visible;
};

/** /api/media/brands/<slug>/videos/<cardId>/…: a card's produced files. */
const brandVideoFromPath = (pathname: string): { slug: string; cardId: string } | null => {
  const m = /^\/api\/media\/brands\/([^/]+)\/videos\/([^/]+)\//.exec(pathname);
  if (!m) return null;
  const slug = safeDecode(m[1]);
  const cardId = safeDecode(m[2]);
  return slug && cardId && isBrandSlug(slug) ? { slug, cardId } : null;
};

/** The brand a video job belongs to, or null. Also fails closed. */
const videoJobBrand = async (jobId: string): Promise<string | null> => {
  try {
    return await brandSlugForVideoJob(query, jobId);
  } catch (err) {
    console.error("proxy: video job brand lookup failed; denying", err);
    return null;
  }
};

const loginRedirect = (req: NextRequest): NextResponse => {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(req.nextUrl.pathname)}`;
  return NextResponse.redirect(url);
};

const notFound = (req: NextRequest): NextResponse =>
  isApiPath(req.nextUrl.pathname)
    ? NextResponse.json({ error: "not found" }, { status: 404 })
    : new NextResponse("Not found", { status: 404 });

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_EXACT.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  const user = await getSessionUser(req.cookies.get(SESSION_COOKIE)?.value);
  if (!user) {
    return isApiPath(pathname) ? NextResponse.json({ error: "log in required" }, { status: 401 }) : loginRedirect(req);
  }

  if (!user.isAdmin && ADMIN_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return notFound(req);
  }

  if (!user.isAdmin) {
    const jobId = jobIdFromPath(pathname);
    if (jobId) {
      const ownerId = await jobOwnerId(jobId);
      if (ownerId !== user.id) {
        // An AI video (job id "<brand slug>-<card id>") has no owner row: it
        // belongs to its brand, so the brand's members may open it.
        const slug = ownerId === null ? await videoJobBrand(jobId) : null;
        if (!slug || !(await canOpenBrand(user, slug))) return notFound(req);
        // …and only once the founder has sent that video to them.
        if (!(await canSeeVideo(user, slug, jobId.slice(slug.length + 1)))) return notFound(req);
      }
    }

    const video = brandVideoFromPath(pathname);
    if (video && !(await canSeeVideo(user, video.slug, video.cardId))) return notFound(req);

    const brandSlug = brandSlugFromPath(pathname);
    if (brandSlug !== null && (brandSlug === "" || !(await canOpenBrand(user, brandSlug)))) {
      return notFound(req);
    }

    const libraryUserId = libraryUserIdFromPath(pathname);
    if (libraryUserId && libraryUserId !== user.id) {
      return notFound(req);
    }
  }

  // Verified downstream of here — route handlers can trust these instead
  // of re-querying the session. Set unconditionally (never merged from the
  // incoming request) so a client can't spoof identity by sending its own
  // copy of these headers.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-user-id", user.id);
  requestHeaders.set("x-user-email", user.email);
  requestHeaders.set("x-user-is-admin", user.isAdmin ? "1" : "0");
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

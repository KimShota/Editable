import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, SESSION_COOKIE } from "./app/lib/session";
import { sql } from "./app/lib/db";

/**
 * Runs in the Node.js runtime (not Edge) — needed for the plain node:crypto
 * + @neondatabase/serverless calls in session.ts/db.ts, and consistent with
 * this app's actual deploy target (a persistent Node server, not Vercel
 * Edge Functions; see the friends-alpha deploy plan). Next 16 supports this
 * natively via this export, no next.config flag required.
 */
export const runtime = "nodejs";

/**
 * Two independent gates layered here:
 *
 * 1. The pre-existing NEXT_PUBLIC_APP_ENABLED="false" switch — deploying
 *    just the marketing page + waitlist to Vercel before the product
 *    (spawned child processes, local-disk jobs/artifacts, no accounts DB
 *    guaranteed to have the migrations below applied) has real
 *    infrastructure to run on. Takes priority over everything below: on
 *    that deploy nothing past "/" and "/api/waitlist" has anywhere to go.
 *
 * 2. Accounts + job ownership, for the real deploy. Invite-gated signup
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
 * 3. Each user's own asset library (library/<userId>/<category>/, see
 *    app/lib/library.ts) is scoped the same way a job is — every route
 *    under api/library/ already resolves to the caller's own userId
 *    server-side, so the only extra thing middleware needs to enforce is
 *    that /api/media/library/<userId>/... can't be fetched by anyone but
 *    that userId (or an admin).
 */

const DEMO_JOB_IDS = new Set(["demo", "five-codes", "five-codes-demo"]);

const LEGACY_WAITLIST_ONLY_ALLOWED = new Set(["/", "/api/waitlist"]);

const PUBLIC_EXACT = new Set(["/", "/login", "/signup"]);
const PUBLIC_PREFIXES = ["/api/auth/", "/api/waitlist"];

const ADMIN_PREFIXES = ["/authoring", "/api/authoring", "/reverse-engineer", "/api/media/authoring"];

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

const isReadOnlyMethod = (method: string): boolean => method === "GET" || method === "HEAD";

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

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (process.env.NEXT_PUBLIC_APP_ENABLED === "false") {
    return LEGACY_WAITLIST_ONLY_ALLOWED.has(pathname) ? NextResponse.next() : new NextResponse("Not found", { status: 404 });
  }

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
      if (DEMO_JOB_IDS.has(jobId)) {
        if (!isReadOnlyMethod(req.method)) {
          return notFound(req);
        }
      } else {
        const ownerId = await jobOwnerId(jobId);
        if (ownerId !== user.id) {
          return notFound(req);
        }
      }
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

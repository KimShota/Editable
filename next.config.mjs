import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // A stray lockfile above this repo can make Next guess the wrong
  // workspace root; pin it explicitly.
  turbopack: { root: __dirname },
  // Browser tests run their own dev server beside the one a developer already
  // has open, and Next allows one dev server per build folder, so tests set
  // NEXT_DIST_DIR=.next-test. Unset, nothing changes.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Next's dev-mode "N" badge sits over the bottom-left corner, on top of the
  // wizard's Back button and the sidebar's Log out, and every other corner has
  // controls too. `npm run app:demo` and the browser tests set this to hide it;
  // ordinary `npm run app:dev` keeps it.
  ...(process.env.KATALAB_HIDE_DEV_INDICATOR === "1" ? { devIndicators: false } : {}),
  // The film-your-own Katalab screens are retired in favour of the AI-video
  // app (plan/ui-ux-full-flow.md §2.5). Their code stays on disk; these
  // routes just land on the calendar. Not permanent (308): the old pages may
  // come back in some form, and a browser must not cache the decision.
  async redirects() {
    return [
      { source: "/projects", destination: "/calendar", permanent: false },
      { source: "/templates", destination: "/calendar", permanent: false },
      { source: "/library", destination: "/calendar", permanent: false },
      { source: "/jobs/:jobId/resources", destination: "/calendar", permanent: false },
    ];
  },
  async rewrites() {
    return {
      // In production Next snapshots public/'s file list ONCE at server
      // boot and never re-reads the directory (see
      // node_modules/next/dist/server/lib/router-utils/filesystem.js —
      // the fs-fallback that makes this work is gated on `opts.dev`).
      // Every job asset the editor plays or shows a thumbnail for is
      // written into public/jobs/<id>/{assets,generated,derived}/... at
      // runtime — stageAssets() on every editor page load, plus the
      // preview-proxy/-thumbnail ffmpeg caches on first request — so any
      // of that gets 404'd until the next deploy restarts the process and
      // re-snapshots public/.
      //
      // `afterFiles` only fires once Next has already tried (and failed
      // to find) a match in that stale snapshot, so a file staged before
      // the last restart is unaffected and keeps serving at full static
      // speed; only a since-added file falls through to this rewrite,
      // which hands it to /api/media (a route that stats the filesystem
      // live on every request, dev or prod).
      afterFiles: [
        {
          source: "/jobs/:jobId/:sub(assets|generated|derived)/:path*",
          destination: "/api/media/public-jobs/:jobId/:sub/:path*",
        },
      ],
    };
  },
  async headers() {
    return [
      {
        // _previews/ holds ONLY previewCachePath's own output (see
        // previewAssets.ts) — every filename there has the source's
        // size+mtime baked in, so a changed source produces a different
        // URL instead of overwriting this one. That's what makes
        // `immutable` safe here specifically: verified before adding this
        // that the plain `public,max-age=0` Next otherwise applies to
        // public/ can in fact be overridden this way (checked against
        // node_modules/next/dist/docs' own Cache-Control section, which
        // calls out immutable-by-filename as the intended use of this
        // config key). Applies whether the request lands on Next's own
        // (boot-snapshotted) public folder serving or falls through this
        // config's own `afterFiles` rewrite to /api/media/public-jobs —
        // headers() is evaluated before both, per Next's documented
        // request-handling order. The media route's own serveFile() sets
        // the SAME header explicitly for this exact path shape too
        // (belt-and-suspenders — it doesn't rely on this config-level
        // header winning over a route handler's own, only on it winning
        // over Next's native static-file default).
        source: "/jobs/:jobId/:sub(assets|generated|derived)/_previews/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
  experimental: {
    // Every request now passes through src/proxy.ts (the renamed middleware.ts, added for the
    // Vercel waitlist gate), and Next caps a request body read inside
    // middleware at 10MB by default — silently truncating any raw video
    // upload (api/jobs/[jobId]/assets) past that, which breaks the
    // multipart parse. Raised well past a phone-recorded clip's size.
    // (Renamed from middlewareClientMaxBodySize, deprecated in Next 16.3 —
    // see node_modules/next/dist/docs — same option, new name.)
    proxyClientMaxBodySize: "2gb",
  },
};

export default nextConfig;

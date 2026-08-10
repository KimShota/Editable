# Editable — Deployment Roadmap

*From "runs on Shota's Mac" to "friends can use it whenever they want."*

Last updated: 2026-08-10 · branch `deployment-ready`

---

## Why this isn't just "push to Vercel"

The marketing page already is on Vercel and should stay there. The
**product** can't go there at all, for three structural reasons:

1. **The filesystem is the database.** `src/app/lib/jobs.ts` says it
   outright — jobs live in `jobs/<id>/`, stage artifacts in
   `artifacts/<id>/`, renders in `out/<id>.mp4`, browser-servable copies
   in `public/jobs/`. Vercel's filesystem is read-only except a 512MB
   ephemeral `/tmp` that vanishes between requests.
2. **Builds and renders are minutes-long child processes.**
   `api/jobs/[jobId]/build` and `.../render` both `spawn("npm", ["run",
   "pipeline", ...])` and report progress through a status file on disk.
   Serverless functions can't outlive their response, and can't share a
   disk between the spawner and the poller.
3. **Native binaries.** The pipeline shells out to `ffmpeg`, `ffprobe`,
   `whisper-cli`, `python3`, and `swift`, plus Remotion's headless
   Chromium and `onnxruntime-node`. `next.config.mjs` also accepts 2GB
   upload bodies; Vercel functions cap request bodies at 4.5MB.

`src/middleware.ts` already had a `NEXT_PUBLIC_APP_ENABLED=false` switch
for exactly this reason — it hides everything but the landing page and
waitlist on the Vercel deploy. That behavior is preserved.

---

## Phase 0 — Ship to friends off this Mac

**Status: code complete, not yet deployed.** Cost: $0.

Everything needed to safely let other people in is written and verified
on the `deployment-ready` branch:

- **Accounts** (`db/migrations/002_accounts.sql`, `src/app/lib/auth.ts`)
  — invite-gated signup, scrypt password hashing via `node:crypto` (no
  new dependencies), sessions stored as SHA-256 token hashes in Neon.
- **Session verification** split into `src/app/lib/session.ts` without a
  `server-only` guard, because middleware isn't compiled in Next's
  react-server graph and that guard throws there. (Confirmed
  empirically — `server-only` threw when the module was loaded outside
  Next's bundler.)
- **The gate** (`src/middleware.ts`) — every route needs a session except
  `/`, `/login`, `/signup`, `/api/auth/*`, `/api/waitlist`. Job routes
  additionally require ownership. `/authoring`, `/api/authoring`, and
  `/reverse-engineer` are admin-only: authoring runs `yt-dlp` against any
  URL a visitor types and spends LLM credits.
- **Job ownership** — `createJob` records an owner; `/projects` and
  `/api/jobs` are scoped per user. The ~90 existing dev/test jobs have no
  recorded owner and are admin-only by default; only `jobs/demo`,
  `jobs/five-codes`, and `jobs/five-codes-demo` are shared example
  content.
- **Concurrency cap** (`src/app/lib/pipelineQueue.ts`) — build and render
  spawns share one semaphore, default 2 concurrent
  (`PIPELINE_MAX_CONCURRENT`). A third simultaneous build queues instead
  of thrashing the CPU.
- **Operator tools** — `npm run db:migrate`, `npm run invites:mint`,
  `npm run admin:promote`.

### What's left to actually go live

1. Clear the `intake.ts` blocker below — it fails `npm run app:build`.
2. `npm run db:migrate && npm run app:build`
3. Run under a supervisor: `pm2 start "npm run app:start" --name editable`
4. `brew install cloudflared` and either `cloudflared tunnel --url
   http://localhost:3100` (instant, random URL) or a named tunnel bound
   to `app.yourdomain.com`.
5. `npm run invites:mint -- --note "alice"`, send
   `/signup?invite=<code>`.

Full step-by-step: `docs/deploy-friends-alpha.md`.

### The hard limit

**The app is only up while the Mac is on, awake, and online.** The tunnel
is just a pipe to `localhost:3100`; it hosts nothing. Note that
`caffeinate -disu` prevents idle sleep but *not* lid-close sleep — on a
laptop this realistically means lid open and plugged in.

Neon is cloud-hosted, so accounts and sessions survive any downtime — but
the app itself is unreachable. Good enough for a scheduled session with a
few friends; not good enough for "here's a link, poke at it this week."

---

## Phase 1 — An always-on Linux box

**Status: not started.** Estimated 2–3 days. Cost: ~€30–85/month.

None of the Phase 0 work is thrown away — accounts, ownership, and the
queue were never Mac-specific. What's left is packaging.

### The shape

```
Vercel (free)     →  marketing + waitlist, NEXT_PUBLIC_APP_ENABLED=false
Docker box + vol  →  app.yourdomain.com: Next.js + pipeline + all job files
Neon (free tier)  →  accounts, sessions, invites, job ownership, waitlist
```

One container, one persistent volume, everything on it — the same
topology as the laptop, which is what the code already assumes. Splitting
frontend from backend would mean an API boundary, object storage, and a
real job queue: weeks of work for an audience of ten.

### The work

- **Dockerfile**: Node 24, `ffmpeg`, `whisper.cpp` built from source
  (the pipeline invokes `whisper-cli`), Chrome headless shell for
  Remotion, plus both model files — `models/ggml-base.en.bin` and
  `models/rvm_mobilenetv3_fp32.onnx`.
- **Volume**: mount `jobs/ artifacts/ out/ public/jobs/ library/`. For
  scale, local usage today is 7.4GB of jobs and 5.4GB of `public/jobs`
  from development alone — start at 100GB+.
- **Ship RVM.** `pipeline/matte.ts` picks RVM when the ONNX model and
  runtime are both present, and falls back to the macOS-only
  `matte.swift` (Apple Vision) when they aren't. On Linux that fallback
  doesn't exist, so the model file must be present, not optional.

### The one real porting decision

Of six formats, four use single-take/`backgroundReplace` and go through
the matte stage — all fine on Linux once RVM ships. But
**`cinematic-debut-manifesto` is the only format with generation slots**,
and its model-shot path calls `matte.swift` for stills plus `python3` for
contact sheets. Options, in order of increasing effort:

1. Leave it out of the friends build (five formats still work).
2. Run it with `--generator gemini`, skipping the local-compositing path.
3. Port the stills path to RVM/ONNX.

### Rough hosting costs

Everything here is CPU-bound (ffmpeg, whisper, Remotion encoding), so
cores matter more than anything else. Verify current pricing — these are
ballpark.

| Platform | Spec | ~Cost/mo | Notes |
|---|---|---|---|
| Hetzner CPX41 | 8 vCPU, 16GB, 240GB | ~€30 | Best CPU per dollar by 3–5×; you manage the box |
| Railway | 4 vCPU / 8GB + volume | ~$35–55 | Easiest Docker + volume story |
| Fly.io | shared-4x 8GB + 100GB vol | ~$60–75 | Docker-native, good regions |
| Render | Pro 4GB / 2CPU + disk | ~$85+ | Simplest UI, weakest CPU for the price |

---

## Phase 2 — When it hurts

**Status: not started.** Triggered by real usage, not a date.

- **Direct-to-R2 uploads.** Gets 2GB request bodies out of Next entirely
  and off the app server's disk. Cloudflare R2 is ~$0.015/GB/month with
  no egress fees.
- **Job metadata into Postgres.** Today `listJobs()` stats every
  directory in `jobs/` on every call; that's fine at 90 jobs and won't be
  at 9,000.
- **Retention policy.** Nothing currently prunes `jobs/`, `artifacts/`,
  `out/`, or `public/jobs/`.
- **Per-user spend caps.** The invite gate limits *who* can trigger paid
  Anthropic/Gemini/Higgsfield calls, but not how much any one of them can
  spend.
- **Password reset.** Deliberately omitted — with a handful of friends,
  resetting by hand is honest scope. Needs an email provider when it
  isn't.

---

## Known blockers

### 1. `intake.ts` fails the production build

`src/backend/pipeline/intake.ts` has uncommitted work-in-progress with
real type errors around a `label` property on slots. This predates the
deployment work and is unrelated to it, but `npm run app:build`
type-checks and **will fail** until it's resolved. Either finish it or
`git stash` it before building.

```bash
npx tsc --noEmit -p tsconfig.json
```

### 2. `next dev` OOMs in this repo

The Turbopack dev server crashed twice with JavaScript heap OOM during
testing, under light load — most likely the file watcher against the
10GB+ of media under `public/` and `jobs/`. Production `next start`
doesn't do this. Use it for anything friends will touch, and don't
benchmark against `next dev`.

---

## Open decisions

| Question | Why it matters |
|---|---|
| Desktop Mac or laptop? | Decides whether Phase 0 is genuinely good enough or just a demo session |
| Own a domain on Cloudflare? | Named tunnel with a stable URL vs. a random one that changes each restart |
| Keep `cinematic-debut-manifesto` in the friends build? | The only format needing a Linux port decision in Phase 1 |
| Hetzner vs. a managed PaaS? | ~3× the CPU per dollar, against having to manage the box yourself |

# Deploying for friends (Phase 0: Cloudflare Tunnel)

Runs the real product — filesystem-backed jobs, spawned pipeline
processes, ffmpeg/whisper/Remotion, everything — off this Mac, reachable
at a public URL, gated behind invite-only accounts. No porting to a VPS
yet; that's Phase 1, once this has actually been used.

See `db/migrations/002_accounts.sql` and `src/middleware.ts` for what
this gate actually does: every route except `/`, `/login`, `/signup`,
and the waitlist requires a session; `/jobs/<id>` and friends
additionally require owning that job; `/authoring`, `/api/authoring`,
and `/reverse-engineer` are admin-only.

## 0. Before you start: a pre-existing blocker

`src/backend/pipeline/intake.ts` currently has uncommitted changes with
real type errors (`npx tsc --noEmit` shows them — unrelated to anything
in this deploy work, already present before it started). `npm run
app:build` runs its own type-check and **will fail** until that's
resolved. Either finish/fix that WIP or `git stash` it before building
for production. Confirm with:

```bash
npx tsc --noEmit -p tsconfig.json
```

## 1. One-time setup

Confirm `.env` has real values for `DATABASE_URL`, `ANTHROPIC_API_KEY`,
and whichever of `GEMINI_API_KEY`/`HIGGSFIELD_API_KEY` your formats use
— unchanged from local dev. `NEXT_PUBLIC_APP_ENABLED` must be **unset**
(that flag is only for the separate waitlist-only Vercel deploy — set to
`"false"` it would gate this deploy down to just the landing page).

```bash
npm install
npm run db:migrate        # applies db/migrations/*.sql, safe to re-run
npm run app:build         # next build — do this after the blocker above is clear
```

## 2. Run it in production mode, not dev

`next dev`'s Turbopack file-watcher has shown real memory instability in
this repo during testing (`public/` and `jobs/` together are 10GB+ of
watched media) — it OOM-crashed twice in under an hour under light load.
`next start` (production) doesn't have this problem; use it for
anything friends will actually hit.

A plain `npm run app:start` dies the moment you close the terminal or the
process crashes. Use a supervisor so it restarts itself and survives you
closing the lid:

```bash
npm install -g pm2
pm2 start "npm run app:start" --name editable
pm2 save
pm2 startup            # prints a command to run once, so pm2 itself
                        # survives a reboot — follow its instructions
```

Useful commands: `pm2 status`, `pm2 logs editable`, `pm2 restart
editable`.

## 3. Keep the Mac from sleeping

The tunnel and the app both die if the Mac sleeps. Either:

- System Settings → Lock Screen → turn off "Turn display off" auto-sleep
  while plugged in, or
- run `caffeinate -disu` in its own terminal (or under `pm2 start
  "caffeinate -disu" --name caffeinate`) to prevent sleep as long as
  it's running.

## 4. Cloudflare Tunnel

```bash
brew install cloudflared
```

**Fastest path (tonight, no domain needed):**

```bash
cloudflared tunnel --url http://localhost:3100
```

Prints a random `https://<something>.trycloudflare.com` URL — share that
with friends. It changes every time you restart this command, and the
tunnel dies if the terminal closes; run it under pm2 too if you want it
to persist:

```bash
pm2 start "cloudflared tunnel --url http://localhost:3100" --name tunnel
pm2 save
```

Check `pm2 logs tunnel` once to grab the printed URL.

**Durable path (a stable `app.yourdomain.com`, if you own a domain on
Cloudflare):**

```bash
cloudflared tunnel login                       # opens a browser, pick the zone
cloudflared tunnel create editable
cloudflared tunnel route dns editable app.yourdomain.com
```

Then a config file at `~/.cloudflared/config.yml`:

```yaml
tunnel: editable
credentials-file: /Users/<you>/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: app.yourdomain.com
    service: http://localhost:3100
  - service: http_status:404
```

```bash
cloudflared service install     # runs as a macOS launchd service —
                                 # survives reboots on its own, no pm2 needed
```

## 5. Get friends in

Signup is invite-only (see `src/app/lib/auth.ts`'s `signup()` — an open
signup form would be an open door to the Anthropic/Gemini/Higgsfield
keys every build spends against).

```bash
npm run invites:mint -- --note "alice"
```

Prints a code. Send them either the code plus the signup page, or a
ready-to-fill link — the signup form reads `?invite=` (see
`src/app/signup/_components/SignupForm.tsx`):

```
https://app.yourdomain.com/signup?invite=<code>
```

To make yourself (or anyone already signed up) an admin — needed for
`/reverse-engineer` and `/authoring`:

```bash
npm run admin:promote -- you@email.com
```

## 6. What to keep an eye on

- **Concurrent builds/renders are capped at 2** (`PIPELINE_MAX_CONCURRENT`
  env var to change it — see `src/app/lib/pipelineQueue.ts`). A third
  friend building at the same time queues instead of piling onto the CPU;
  the build status just reads "queued" until a slot frees.
- **Disk usage.** `jobs/`, `artifacts/`, `out/`, and `public/jobs/` all
  grow with every upload/render and nothing currently prunes them —
  check `du -sh jobs artifacts out public/jobs` occasionally.
- **API spend.** Every build/render call can hit Anthropic/Gemini/
  Higgsfield — there's no per-user spend cap yet, just the invite gate
  limiting who can trigger it at all.
- **Existing dev/test jobs stay private.** The ~90 jobs already in
  `jobs/` from building this app have no recorded owner, so they're
  admin-only by default — friends won't see them in Projects. Only
  `jobs/demo`, `jobs/five-codes`, and `jobs/five-codes-demo` are treated
  as shared example content (see `src/middleware.ts`'s `DEMO_JOB_IDS`).

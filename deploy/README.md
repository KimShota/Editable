# Deploy runbook

Costed plan and rationale: `docs/deployment-plan.md`. This file is the
commands.

Target: one Ubuntu 24.04 box, 4 vCPU / 8GB / 80GB. Everything — Next.js,
the pipeline, and all job files — runs on it, which is the topology the
code already assumes (`src/app/lib/jobs.ts` treats the filesystem as the
database).

---

## 1. Create the server

Hetzner Console → **CX33**, Ubuntu 24.04, SSH key attached at create time.
Region by where the people *uploading takes* are — that's the heavy path.
No extra volume; the included 80GB holds roughly 480 jobs at the ~147MB
per job the dev data averages.

Point your hostname's **A record** straight at the IP. No proxy in front —
Cloudflare's free and Pro plans cap request bodies at 100MB and would break
take uploads.

## 2. Provision

```bash
ssh root@<ip> 'bash -s' < deploy/provision.sh
```

Installs Node 24, ffmpeg, Chromium's runtime libs, python3-pil, fonts,
Caddy and ufw; builds whisper.cpp from source; downloads both models;
creates the `editable` user and a 4GB swapfile. Idempotent — re-run it if a
step fails.

## 3. Deploy the app

```bash
ssh root@<ip>
sudo -u editable -H bash

cd /opt/editable
# NOT `git clone . ` — provision.sh already created models/ here, and clone
# refuses a non-empty directory. init+fetch works against existing files
# (models/ is gitignored, so nothing collides).
git init -q
git remote add origin <your-repo-url>
# The server tracks main: whatever is on main is what production runs, so
# "merged to main" and "deployed" don't drift apart. (This box ran the
# deployment-ready branch during the initial build-out; that branch was
# merged into main and is no longer what production follows.)
git fetch -q --depth 1 origin main
git checkout -q -B main FETCH_HEAD

# devDependencies are REQUIRED: render.ts shells out to `npx remotion
# render`, and the Remotion CLI is a devDependency. Never --omit=dev.
npm ci

cp deploy/env.example .env
chmod 600 .env
$EDITOR .env

npm run db:migrate
npm run app:build
exit
```

`models/`, `artifacts/`, `public/jobs/`, `library/` and `jobs/*` (except the
three demos) are gitignored — provision.sh creates `models/`, the rest are
created on first use.

## 4. Start it

```bash
install -m 644 /opt/editable/deploy/editable.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now editable
systemctl status editable
journalctl -u editable -f
```

## 5. TLS

```bash
sed "s/app.example.com/<your-hostname>/" /opt/editable/deploy/Caddyfile > /etc/caddy/Caddyfile
mkdir -p /var/log/caddy
caddy validate --config /etc/caddy/Caddyfile
# AFTER validate, not before: `caddy validate` run as root instantiates the
# logger and creates editable.log owned by root:root 0600. The service runs
# as `caddy` and then can't append to it — the failure looks like a
# filesystem permission bug but the directory is fine; it's that one file.
chown -R caddy:caddy /var/log/caddy
systemctl restart caddy && systemctl is-active caddy
```

Certificate issuance takes a few seconds on first request. Then **verify a
>100MB upload end-to-end before inviting anyone** — that path has more ways
to fail quietly than anything else here.

## 6. Let people in

```bash
sudo -u editable -H bash -c 'cd /opt/editable && npm run invites:mint -- --note "alice"'
```

Send them `https://<host>/signup?invite=<code>`. Sign up yourself first,
then:

```bash
sudo -u editable -H bash -c 'cd /opt/editable && npm run admin:promote -- <your-email>'
```

Finally, point the Vercel marketing deploy's "open app" link at the new
host. Vercel keeps `NEXT_PUBLIC_APP_ENABLED=false`.

---

## Smoke test

Nothing below is verifiable from a Mac — the first run on the box is where
each one actually gets tested:

1. **onnxruntime-node** — `npx tsx src/backend/pipeline/generation/rvmStillsCli.ts <dir-of-pngs> /tmp/masks`
   proves the linux-x64 prebuilt loaded and the RVM model runs.
2. **Remotion's headless Chromium** — `npx remotion browser ensure`, then a
   render. This is where a missing `lib*` shows up.
3. **whisper.cpp** — a full build on a real take.
4. One build + render per format, cinematic last (it's the only one that
   spends on generation).

## Updating

Automatic. `editable-deploy.timer` checks `origin/main` every 3 minutes and
runs `deploy/update.sh` when it moved, so **merged to main means deployed**
with nothing left to remember. Install it once:

```bash
install -m 644 /opt/editable/deploy/editable-deploy.service /etc/systemd/system/
install -m 644 /opt/editable/deploy/editable-deploy.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now editable-deploy.timer

systemctl list-timers editable-deploy   # next firing
journalctl -u editable-deploy -f        # watch a deploy happen
```

`update.sh` lives in the repo, so it updates itself along with everything
else. It does, in order: shallow-fetch `main`; **exit silently if HEAD
already matches** (the common case — a timer tick that finds nothing costs
one fetch); **defer if any job is in flight**; then `npm ci`, `db:migrate`,
`app:build`, `systemctl restart editable`, and confirm the service is
actually up 5s later.

`db:migrate` is in there deliberately — it's a no-op when there's nothing
new (it tracks applied files in `schema_migrations`), and leaving it out is
how you end up with code that expects a table the database doesn't have.

### Why it defers instead of just deploying

`npm ci` **deletes `node_modules` before reinstalling it**, and a running
build or render is a child process reading out of exactly that directory —
`tsx`, the Remotion CLI, `onnxruntime-node`'s prebuilt `.node`. Deploying
under a live job doesn't merely restart it early; it pulls the interpreter
out from under a process that's minutes into writing job artifacts. So the
script treats a busy box as a reason to come back in 3 minutes.

"Busy" is two checks, because neither alone is sufficient:

- **`pgrep` for `pipeline/run.ts`** — ground truth for work that's actually
  executing, and immune to stale files.
- **`artifacts/*/{build,render}-status.json` reading `building`/
  `rendering`** — catches a job the API has accepted but which is still
  parked in `pipelineQueue`'s in-memory waiter list with no process yet.
  Restarting drops that job with no record it was ever queued; the browser
  just polls a status file that never advances.

The status-file check ignores anything untouched for `STALE_AFTER_MIN`
(default 180). Without that cutoff, one process killed mid-build leaves a
file reading `"building"` forever and blocks every future deploy.

### Driving it by hand

```bash
systemctl start editable-deploy.service   # deploy now, same guards
FORCE=1 /opt/editable/deploy/update.sh    # skip the in-flight check
systemctl stop editable-deploy.timer      # pause auto-deploy (e.g. during a demo)
```

A failed deploy **does not restart the service** — the box keeps serving the
previous build, and the journal prints the exact rollback command with the
old SHA in it.

### Two things it doesn't solve

- **`next build` overwrites `.next` under the running server.** For the
  ~1–2 minutes between build start and restart, the live process can serve
  from a directory being rewritten under it. This is inherent to the
  manual sequence too, and idle-only deploys keep the exposure small — but
  if it ever bites, the fix is building to a fresh `distDir` and swapping.
- **Deploys are branch-triggered, not reviewed.** Anything merged to `main`
  is live within ~3 minutes. That's the point, but it does mean `main`
  needs to stay deployable.

## Watch

- `df -h` — nothing prunes `jobs/`, `artifacts/`, `out/` or `public/jobs/`.
- `journalctl -u editable -p err`
- Spend limits (hard limits, not just alerts) in the Anthropic, Gemini and
  Higgsfield consoles. The invite gate controls *who* spends, not how much.

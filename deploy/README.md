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
git fetch -q --depth 1 origin deployment-ready
git checkout -q -B deployment-ready FETCH_HEAD

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

```bash
sudo -u editable -H bash -c 'cd /opt/editable && git pull && npm ci && npm run app:build'
systemctl restart editable
```

## Watch

- `df -h` — nothing prunes `jobs/`, `artifacts/`, `out/` or `public/jobs/`.
- `journalctl -u editable -p err`
- Spend limits (hard limits, not just alerts) in the Anthropic, Gemini and
  Higgsfield consoles. The invite gate controls *who* spends, not how much.

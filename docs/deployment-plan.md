# Editable — Cheap Deployment Plan

*The concrete, costed version of `deployment-roadmap.md` Phase 1.*
*Target: ~€9/month, live this week.*

Written 2026-08-10 · branch `deployment-ready`

---

## The shape

Unchanged from the roadmap — it was right:

```
Vercel (free)     →  marketing + waitlist, NEXT_PUBLIC_APP_ENABLED=false
Hetzner CX33      →  app.<domain>: Next.js + pipeline + all job files
Neon (free tier)  →  accounts, sessions, invites, job ownership, waitlist
```

One box, one disk, everything on it. That's the topology the code already
assumes (`src/app/lib/jobs.ts` treats the filesystem as the database), so
matching it is the cheap path, not a compromise.

---

## Cost

| Item | Cost |
|---|---|
| Hetzner CX33 — 4 vCPU, 8GB, 80GB NVMe, 20TB traffic | €8.49/mo |
| IPv4 address | €0.50/mo |
| TLS (Let's Encrypt via Caddy) | €0 |
| Domain — DuckDNS subdomain | €0 (or ~$12/yr for a real one) |
| Neon free tier | €0 |
| Vercel hobby | €0 |
| **Fixed total** | **≈ €9/mo (~$10)** |

Prices are post the 15 June 2026 Hetzner adjustment; confirm at signup.

**No block-storage volume.** The 80GB included with the CX33 is enough —
see "Storage sizing" below.

### If €9 is still too much, or not enough

| Option | Cost | Verdict |
|---|---|---|
| CX23 — 2 vCPU, 4GB, 40GB | €5.49/mo | Risky. `npx remotion render` bundles with esbuild *and* runs headless Chromium; 4GB is an OOM edge. Only with `PIPELINE_MAX_CONCURRENT=1` + swap. |
| **CX33 — 4 vCPU, 8GB, 80GB** | **€8.49/mo** | **Recommended.** |
| CX43 — 8 vCPU, 16GB, 160GB | €15.99/mo | Roughly halves render wall-time. Resize into it later if renders feel slow — Hetzner rescale is a reboot, and disk only grows. |
| Oracle Cloud Always Free — 4 ARM cores, 24GB | €0 | Tempting, not recommended first. ARM64 means Chrome for Testing ships no `linux-arm64` headless shell, so Remotion needs system chromium + an explicit `browserExecutable`. Plus capacity is hard to get and idle instances get reclaimed. |

The roadmap's table (CPX41 ~€30, Railway/Fly/Render €35–85) priced this
~3× too high. The cost-optimized **CX** line is the right fit; the CPX line
it quoted now starts at €69.49/mo for 8 vCPU.

---

## Scope: all six formats — porting done

Shipping all six means `cinematic-debut-manifesto` has to run on Linux,
which means replacing its macOS-only pieces. **That work is complete and
verified** (see "Port status" below).

For the record, the Swift/Vision dependency was confined to that one
format, so a five-format launch would have needed no porting at all:

- `formats/cinematic-debut-manifesto.json` is the **only** format with
  `"backgroundReplace": true` (4 blocks). The others set it explicitly
  false — `abcd-heavier-to-carry-quiz` ×6, `one-tool-per-task-rapidfire`
  ×12, `tier-ranked-tools-per-usecase` ×7 — and `cs-resources` /
  `five-secret-codes` never mention it (schema default is `false`).
- `intake.ts:153` — `if (!format.blocks.some((b) => b.backgroundReplace)) return;`
  guards the unprotected `matteFramesBatch` at `intake.ts:160`. Unreachable
  for the other five.
- `shotQC.ts:121` (`mattePersonToFile`) is reached only through
  `generatedShots.ts:232` — i.e. generation slots. Only
  `cinematic-debut-manifesto` declares any.
- `contactSheet.ts:136`'s `python3` sits on that same generation path.
- `matte.ts:171` and `:255` are in the `else` of `if (engine === "rvm")`,
  and `matte.ts:200` sets `engine = rvmAvailable() ? "rvm" : "vision"`.
  Shipping `models/rvm_mobilenetv3_fp32.onnx` pins it to `rvm`.
- Both demo jobs avoid it: `jobs/demo` → `cs-resources`,
  `jobs/five-codes-demo` → `five-secret-codes`.

*(Should you ever want to drop it again: `loader.ts:111`'s `listFormats()`
reads only `*.json` directly in `formats/`, so `git mv`-ing the file into a
subdirectory removes it from the gallery with no code change.)*

---

## Port status

### 1. RVM stills path — done

`generation/rvmStills.ts` (engine) + `generation/rvmStillsCli.ts`
(subprocess entry). `matteFramesBatch` now prefers RVM whenever
`rvmAvailable()`, and falls back to `matte.swift` only on macOS; off macOS
a missing model is an explicit error instead of an ENOENT from `swift`.

Two design points worth keeping:

- **The subprocess boundary is load-bearing.** ORT's `create`/`run` are
  async, but `matteFramesBatch` is synchronous underneath two synchronous
  callers — `intake.ts`'s `checkTalkingHeadFraming` and `shotQC.ts`'s
  `measureGeometry` (inside `generatedShots`' retry loop). Awaiting through
  them would force an async refactor across intake and QC for no gain.
- **Recurrent state resets per image.** `runRvmOnFrames` threads r1..r4
  between frames because they're consecutive; intake samples 9 frames
  spread across a whole take, so carrying state would contaminate each mask
  with the previous sample's geometry.

**Verified against the Swift baseline** on a real speaking take
(`jobs/cinematic-debut-manifesto-ebfff3`), sampled exactly as intake does
(9 frames, `fps = 9/duration`, 720x1280):

| engine | headTop | headBot | subjBot | headHeights | verdict |
|---|---|---|---|---|---|
| RVM | 0.2852 | 0.4766 | 0.8047 | 2.714 | accept |
| Swift | 0.2859 | 0.4727 | 0.8047 | 2.778 | accept |

Against a `requiredHeadHeights` of 2.271 (reject below 2.121), the two
engines land 2.3% apart and well clear of the threshold — intake's
accept/reject decision does not change. Per-frame masks agree at 98.4%
pixel-for-pixel (IoU 89.1%), and RVM's are visibly cleaner: Vision leaves
grey semi-transparent contamination through the hair and along the arms
where RVM is solid. `measureGeometry` was also exercised end-to-end through
the new subprocess wiring (~0.6s per call).

### 2. Deterministic text rendering — done

`SYSTEM_FONT` was the bare OS stack, which resolves to San Francisco on a
Mac and to **none of its entries** on Ubuntu — falling through to whatever
`sans-serif` maps to, whose wider metrics rewrap captions and titles. This
affected all six formats, not just cinematic.

Inter is now pinned in front of the stack and self-hosted at
`public/fonts/inter-variable.woff2` (352KB, one variable file covering
400/500/800/900), loaded by the same `@font-face` mechanism as the existing
display faces. `EdlVideo` calls `ensureDisplayFonts()` at the composition
**root** — `HookBlock`/`ResourceBlock`/`CtaBlock`/`ImageOverlay` all style
with `SYSTEM_FONT` but never called in, so per-component injection would
have made Inter's presence depend on which overlays a frame happened to
contain.

Confirmed applied by rendering the same frame with and without the pin:
0.80% of pixels differ, entirely within the caption band (rows 919–971),
video content byte-identical. The look change on macOS is slight — Inter
sits marginally tighter than SF.

### 3. Contact-sheet labels — done

`contactSheet.ts`'s Python grid hard-coded `/System/Library/Fonts/Helvetica.ttc`
and fell back to PIL's `load_default()`, a bitmap face that would have made
cinematic's QC labels unreadable on the server. DejaVu and Liberation paths
are now tried before that last resort.

### 4. Still needed on the box

`python3` with **Pillow** (`apt install python3-pil`) — cinematic's contact
sheets are the only thing that needs it, and it's the one remaining
non-Node dependency the other five formats don't have.

---

## Corrections to `deployment-roadmap.md`

1. **Blocker #1 is cleared.** `npx tsc --noEmit` exits clean and
   `npm run app:build` completes. The `intake.ts` type errors were fixed in
   `be5f86d`.
2. **Cloudflare Tunnel would silently break uploads.** Phase 0 recommends
   `cloudflared`. Cloudflare's Free *and* Pro plans cap proxied request
   bodies at **100MB**; `next.config.mjs` sets
   `middlewareClientMaxBodySize: "2gb"` precisely because takes are large. A
   phone-recorded take will fail at the edge, before Next sees it. Use a
   direct A record + Caddy. (Caddy has no default body cap — nginx's 1MB
   default would need raising.)
3. **Storage sizing.** "Start at 100GB+" came from 7.4GB `jobs/` + 5.5GB
   `public/jobs/` accumulated over ~90 dev/test jobs. A fresh box needs
   models (155MB) + the 3 demo jobs (~32MB) + `node_modules` + OS — under
   20GB. The CX33's 80GB is fine; add a volume (€0.0572/GB/mo) when it
   fills.

---

## Steps

### A. Provision (~1h)

1. Hetzner account → **CX33, Ubuntu 24.04**. Region by friend latency
   (Falkenstein/Nuremberg for EU, Ashburn/Hillsboro for US — same price).
   Attach your SSH key at create time. New accounts sometimes hit ID
   verification; start this first.
2. Non-root deploy user; `ufw allow 22,80,443`; disable SSH password auth;
   enable `unattended-upgrades`.
3. Add 4GB swap — cheap insurance against an esbuild/Chromium spike.

### B. Dependencies

- Node 24 (NodeSource), `ffmpeg`, `python3`, `build-essential`, `cmake`.
- **`python3-pil`** — cinematic's contact sheets import PIL.
- **`fonts-dejavu-core`** — for those same contact sheets (the compositions
  themselves no longer depend on system fonts; see Port status #2).
- `yt-dlp` only if you want `/authoring` (admin-only) working.
- **whisper.cpp from source** — apt has no `whisper-cli`. Build it, then
  symlink `build/bin/whisper-cli` into `/usr/local/bin`.
- **Remotion's browser**: `npx remotion browser ensure`, plus the Chromium
  system libs Remotion's Linux docs list.
- **Models** (both gitignored, so they must be downloaded, not cloned) —
  URLs are in `README.md:76-84`:
  - `models/ggml-base.en.bin` (148MB)
  - `models/rvm_mobilenetv3_fp32.onnx` (15MB) — **required** on Linux, not
    optional as the README says; the Vision fallback doesn't exist here.

### C. App

- Clone `deployment-ready`. Note `.gitignore`: `models/`, `artifacts/`,
  `public/jobs/`, `/library`, and `jobs/*` (except the 3 demos) don't come
  with the clone — they're created on the box.
- `.env`: `DATABASE_URL` (Neon), `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
  `HIGGSFIELD_API_KEY`/`HIGGSFIELD_API_SECRET`, `WAITLIST_IP_SALT`,
  `PIPELINE_MAX_CONCURRENT=2`. Leave `NEXT_PUBLIC_APP_ENABLED` unset.
  Shipping cinematic means the generation keys have to be present — see the
  budget note below, because that's where the money is.
- `npm ci` — **do not** pass `--omit=dev`. `render.ts:38` shells out to
  `npx remotion render`, and the Remotion CLI is a devDependency.
- `npm run db:migrate` → `npm run app:build`
- systemd unit: `npm run app:start` (port 3100), `Restart=always`,
  `EnvironmentFile=`, generous `TimeoutStopSec` so an in-flight render isn't
  killed mid-write.

### D. Domain + TLS

- DuckDNS subdomain (free) or a real domain; **A record straight to the IP,
  no proxy**.
- Caddy: `reverse_proxy localhost:3100`, automatic Let's Encrypt.
- Verify a **>100MB** upload end-to-end before inviting anyone.

### E. Cut over

- Vercel project keeps `NEXT_PUBLIC_APP_ENABLED=false`; point its "open app"
  link at the new host.
- `npm run db:migrate`, `npm run invites:mint`, sign up, `npm run admin:promote`.
- Smoke test: a full build + render on one job per shipped format.

---

## What actually threatens the budget

The €9 is fixed. The uncapped item is **API spend** — every build calls
Anthropic for role resolution and transcript correction
(`resolvers/index.ts` `pickResolver`/`pickCorrector`, auto → Anthropic
whenever `ANTHROPIC_API_KEY` is set). The invite gate controls *who*
spends, not *how much*.

Shipping all six formats raises this materially. `cinematic-debut-manifesto`
is the only format with generation slots (6 of them), so it's the only one
that spends on Gemini/Higgsfield image and video generation — per build,
and again on every QC retry inside `generatedShots`. The other five cost
only the Anthropic resolver/corrector calls.

- Set a hard spend limit in the Anthropic console, not just an alert. Do
  the same on Gemini/Higgsfield.
- Keep the invite count in single digits to start.
- If spend gets uncomfortable, dropping cinematic back out of the gallery
  is a one-command `git mv` (see Scope above) and costs nothing else.

Secondary: nothing prunes `jobs/`, `artifacts/`, `out/`, or `public/jobs/`
— ~90 dev jobs cost 13GB, so watch `df` on the 80GB disk. Traffic is a
non-issue (20TB included).

---

## Verify on the box, not from here

- Remotion's headless Chromium against Ubuntu 24.04's libs — the first
  render is where that surfaces.
- `onnxruntime-node` prebuilt binary on linux-x64 (another reason not to
  pick ARM).
- whisper.cpp build takes a few minutes.
- The roadmap's `next dev` OOM is dev-only — `next start` is unaffected.

**Realistic effort:** half a day to a day, first time through.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Inserts } from "../types";

/**
 * The plan's own human checkpoint (§3): one image showing every generated
 * shot, its flag (green = shipped clean, orange = shipped on aesthetic
 * bands only — needs a look, red = tiered down to the composite fallback
 * after every Gemini attempt failed identity/plate-structure), and its
 * key QC numbers, so a human can review before render rather than
 * discovering a problem in the finished video.
 *
 * Text is composited via PIL (a Python subprocess), not ffmpeg's own
 * drawtext filter — this environment's ffmpeg build has no drawtext
 * (confirmed: `ffmpeg -filters | grep drawtext` returns nothing, almost
 * certainly built without libfreetype/fontconfig), so the label/border
 * work happens in Python instead of failing outright.
 */

const FLAG_COLOR: Record<string, [number, number, number]> = {
  green: [46, 160, 67],
  orange: [230, 150, 30],
  red: [220, 50, 47],
};

const extractFirstFrame = (videoPath: string, outPngPath: string): void => {
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", videoPath, "-frames:v", "1", outPngPath]);
};

type Tile = { imagePath: string; label: string; flag: "green" | "orange" | "red"; summary: string };

const PYTHON_GRID_SCRIPT = `
import json, sys
from PIL import Image, ImageDraw, ImageFont

manifest = json.load(open(sys.argv[1]))
tiles = manifest["tiles"]
out_path = manifest["outPath"]

TILE_W, TILE_H = 220, 400
BORDER = 8
PAD = 6
LABEL_H = 44

cols = min(3, max(1, len(tiles)))
rows = (len(tiles) + cols - 1) // cols
cell_w = TILE_W + PAD * 2
cell_h = TILE_H + LABEL_H + PAD * 2
sheet = Image.new("RGB", (cell_w * cols, cell_h * rows), (20, 20, 20))
draw = ImageDraw.Draw(sheet)
try:
    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 16)
    font_small = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 12)
except Exception:
    font = ImageFont.load_default()
    font_small = font

for i, t in enumerate(tiles):
    col, row = i % cols, i // cols
    x0, y0 = col * cell_w, row * cell_h
    im = Image.open(t["imagePath"]).convert("RGB")
    im.thumbnail((TILE_W - BORDER * 2, TILE_H - BORDER * 2))
    color = tuple(t["color"])
    tile_bg = Image.new("RGB", (TILE_W, TILE_H), color)
    ix = (TILE_W - im.width) // 2
    iy = (TILE_H - im.height) // 2
    tile_bg.paste(im, (ix, iy))
    sheet.paste(tile_bg, (x0 + PAD, y0 + PAD))
    draw.text((x0 + PAD, y0 + PAD + TILE_H + 4), f"{t['label']} [{t['flag'].upper()}]", fill=(255,255,255), font=font)
    draw.text((x0 + PAD, y0 + PAD + TILE_H + 24), t["summary"][:40], fill=(200,200,200), font=font_small)

sheet.save(out_path, quality=90)
print("OK", out_path)
`;

/** Builds one contact-sheet JPG from every insert in `inserts` worth
 *  showing: a QC-flagged generatedScene shot, OR a montageReel/triptych
 *  with per-member tier info even when its own aggregate flag is absent
 *  (e.g. every member is a plain composite with no QC ladder at all —
 *  tier truth still belongs on the sheet). Writes nothing and returns
 *  false if there's nothing to show. */
export const buildContactSheet = (jobDir: string, inserts: Inserts, outPath: string): boolean => {
  const shown = inserts.inserts.filter((i) => {
    const qc = (i.qc ?? {}) as { members?: Array<{ label: string; tier: string }> };
    return i.flag !== undefined || (qc.members?.length ?? 0) > 0;
  });
  if (shown.length === 0) return false;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-contactsheet-"));
  try {
    const tiles: Array<Tile & { color: [number, number, number] }> = [];
    for (const insert of shown) {
      const absVideoPath = path.join(jobDir, insert.path);
      const framePath = path.join(workDir, `${insert.slotName}.png`);
      try {
        extractFirstFrame(absVideoPath, framePath);
      } catch (err) {
        console.warn(`contactSheet: could not extract a frame for "${insert.slotName}" — ${(err as Error).message}`);
        continue;
      }
      const qc = (insert.qc ?? {}) as Record<string, unknown>;
      const attempts = Array.isArray(qc.attempts) ? (qc.attempts as Array<Record<string, unknown>>) : undefined;
      const lastAttempt = attempts?.[attempts.length - 1];
      const geometry = lastAttempt?.geometry as Record<string, unknown> | undefined;
      const members = qc.members as Array<{ label: string; tier: string; flag?: string }> | undefined;
      // Tier truth, always shown when known: the single top-level tier
      // (generatedScene), or one letter per montageReel/triptych member
      // (g=gemini, c=composite, r=reuse, x=realCrop, t=templateClip) so a
      // tier-down is visible at a glance instead of requiring a trouser-
      // color inspection to notice.
      const tierTag = typeof qc.tier === "string"
        ? `tier=${qc.tier}`
        : members
          ? `tiers=[${members.map((m) => m.tier[0]).join("")}]`
          : undefined;
      const geometrySummary = geometry ? `bbox=${Number(geometry.bboxHeightFrac ?? 0).toFixed(2)}H luma=${geometry.subjectMedianLuma ?? "?"}` : undefined;
      const summary = [tierTag, geometrySummary ?? (typeof qc.note === "string" ? qc.note : undefined)].filter(Boolean).join(" ");
      const flag = (insert.flag ?? "orange") as "green" | "orange" | "red";
      tiles.push({
        imagePath: framePath,
        label: insert.slotName,
        flag,
        summary,
        color: FLAG_COLOR[flag] ?? [80, 80, 80],
      });
    }

    if (tiles.length === 0) return false;

    const manifestPath = path.join(workDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify({ tiles, outPath }));
    const scriptPath = path.join(workDir, "grid.py");
    fs.writeFileSync(scriptPath, PYTHON_GRID_SCRIPT);
    execFileSync("python3", [scriptPath, manifestPath], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

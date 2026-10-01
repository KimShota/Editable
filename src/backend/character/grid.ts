import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * One labelled grid image of several stills, so a customer (or the founder,
 * in the pilot) compares mascot candidates or a sheet's views at a glance.
 * PIL rather than ffmpeg: this machine's ffmpeg has no drawtext (see
 * pipeline/generation/contactSheet.ts).
 */

const SCRIPT = `
import json, sys
from PIL import Image, ImageDraw, ImageFont
m = json.load(open(sys.argv[1]))
tiles, cols, size = m["tiles"], m["cols"], m["size"]
label_h = 44
rows = (len(tiles) + cols - 1) // cols
sheet = Image.new("RGB", (cols * size, rows * (size + label_h)), (255, 255, 255))
try:
    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 26)
except Exception:
    font = ImageFont.load_default()
draw = ImageDraw.Draw(sheet)
for i, t in enumerate(tiles):
    x, y = (i % cols) * size, (i // cols) * (size + label_h)
    im = Image.open(t["path"]).convert("RGB")
    im.thumbnail((size, size))
    sheet.paste(im, (x + (size - im.width) // 2, y + (size - im.height) // 2))
    draw.text((x + 12, y + size + 8), t["label"], fill=(20, 20, 20), font=font)
sheet.save(m["out"])
`;

export const buildGrid = (tiles: { path: string; label: string }[], outPath: string, cols = 3, size = 512): void => {
  if (tiles.length === 0) throw new Error("grid: no tiles");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "katalab-grid-"));
  try {
    const manifest = path.join(dir, "m.json");
    const script = path.join(dir, "grid.py");
    fs.writeFileSync(manifest, JSON.stringify({ tiles, cols: Math.min(cols, tiles.length), size, out: outPath }));
    fs.writeFileSync(script, SCRIPT);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    execFileSync("python3", [script, manifest], { stdio: ["ignore", "ignore", "pipe"] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

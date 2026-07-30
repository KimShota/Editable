import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { jobExists, jobDir } from "../../../../../lib/jobs";
import { readOrMigrateEdl } from "@backend/pipeline/orchestrate";
import { applyOp, TimelineOp } from "@backend/pipeline/timelineOps";
import { artifactsDir, publicJobPrefix } from "@backend/pipeline/paths";
import { stageAssets } from "@backend/pipeline/render";
import { probeFile } from "@backend/pipeline/intake";

/**
 * Lets the editor pull in media the user didn't have bound at intake time —
 * a music bed, a sound effect, an image/video overlay, or an extra b-roll
 * clip — instead of only ever editing what assemble() originally produced.
 * Two-step, same division of labor as /timeline/op: this route owns the
 * filesystem (save the upload, probe it, register+stage it as an asset);
 * applyOp stays a pure reducer that just wires the resulting src into the
 * EDL's data.
 */

type Kind = "music" | "sfx" | "overlayImage" | "overlayVideo" | "video";
const KINDS: Kind[] = ["music", "sfx", "overlayImage", "overlayVideo", "video"];

/** Same box-fitting idea as assemble.ts's own defaultOverlayBox — centered,
 *  as large as it can be within the component's usual max size without
 *  exceeding the media's own aspect ratio. Kept local rather than shared:
 *  assemble.ts's version is a closure over that function's own `format`. */
const OVERLAY_BOX_MAX: Record<string, { maxWidthFrac: number; maxHeightFrac: number }> = {
  ImageOverlay: { maxWidthFrac: 0.7, maxHeightFrac: 0.6 },
  VideoOverlay: { maxWidthFrac: 0.88, maxHeightFrac: 0.62 },
};
const defaultOverlayBox = (
  component: string,
  mediaWidth: number | undefined,
  mediaHeight: number | undefined,
  formatWidth: number,
  formatHeight: number,
): { x: number; y: number; width: number; height: number } => {
  const bounds = OVERLAY_BOX_MAX[component];
  if (!bounds || !mediaWidth || !mediaHeight) return { x: 0, y: 0, width: 1, height: 1 };
  const maxWidthPx = bounds.maxWidthFrac * formatWidth;
  const maxHeightPx = bounds.maxHeightFrac * formatHeight;
  const aspect = mediaWidth / mediaHeight;
  let widthPx = maxWidthPx;
  let heightPx = maxWidthPx / aspect;
  if (heightPx > maxHeightPx) {
    heightPx = maxHeightPx;
    widthPx = maxHeightPx * aspect;
  }
  const width = widthPx / formatWidth;
  const height = heightPx / formatHeight;
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
};

/** Default on-timeline duration for a dropped image (which has no
 *  intrinsic duration of its own) — long enough to register, short enough
 *  not to dominate the cut. */
const IMAGE_OVERLAY_DEFAULT_SEC = 3;

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }

  const formData = await req.formData();
  const file = formData.get("file");
  const kind = formData.get("kind");
  const atSecRaw = formData.get("atSec");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing file" }, { status: 400 });
  }
  if (typeof kind !== "string" || !KINDS.includes(kind as Kind)) {
    return NextResponse.json({ error: `kind must be one of ${KINDS.join(", ")}` }, { status: 400 });
  }
  const atSec = Math.max(0, Number(atSecRaw) || 0);

  // Save the raw upload under the job's own dir first — probing and
  // staging both need bytes on disk.
  const ext = path.extname(file.name) || "";
  const uploadName = `${randomBytes(4).toString("hex")}${ext}`;
  const relPath = path.posix.join("assets", "uploads", uploadName);
  const absPath = path.join(jobDir(jobId), relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, Buffer.from(await file.arrayBuffer()));

  let probed: ReturnType<typeof probeFile>;
  try {
    probed = probeFile(absPath);
  } catch (err) {
    fs.unlinkSync(absPath);
    return NextResponse.json({ error: `couldn't read "${file.name}": ${(err as Error).message}` }, { status: 400 });
  }

  const expectedMediaType: Record<Kind, ReturnType<typeof probeFile>["mediaType"]> = {
    music: "audio",
    sfx: "audio",
    overlayImage: "image",
    overlayVideo: "video",
    video: "video",
  };
  if (probed.mediaType !== expectedMediaType[kind as Kind]) {
    fs.unlinkSync(absPath);
    return NextResponse.json(
      { error: `expected ${expectedMediaType[kind as Kind]} for "${kind}", got ${probed.mediaType}` },
      { status: 400 },
    );
  }

  const edl = await readOrMigrateEdl(jobDir(jobId), jobId);
  const src = path.posix.join(publicJobPrefix(jobId), relPath);
  // applyOp clones its input, so registering the asset here carries it
  // through into the op's own result too.
  edl.assets[src] = absPath;

  let op: TimelineOp;
  switch (kind as Kind) {
    case "music":
      op = { type: "addMusic", src, tlInSec: atSec, durationSec: probed.durationSec };
      break;
    case "sfx":
      op = { type: "addSfx", src, tlInSec: atSec, durationSec: probed.durationSec };
      break;
    case "overlayImage": {
      const box = defaultOverlayBox("ImageOverlay", probed.width, probed.height, edl.width, edl.height);
      op = {
        type: "addOverlay",
        src,
        component: "ImageOverlay",
        tlInSec: atSec,
        tlOutSec: atSec + IMAGE_OVERLAY_DEFAULT_SEC,
        ...box,
      };
      break;
    }
    case "overlayVideo": {
      const box = defaultOverlayBox("VideoOverlay", probed.width, probed.height, edl.width, edl.height);
      op = {
        type: "addOverlay",
        src,
        component: "VideoOverlay",
        tlInSec: atSec,
        tlOutSec: atSec + (probed.durationSec ?? IMAGE_OVERLAY_DEFAULT_SEC),
        ...box,
      };
      break;
    }
    case "video":
      if (!probed.durationSec) {
        fs.unlinkSync(absPath);
        return NextResponse.json({ error: "couldn't determine video duration" }, { status: 400 });
      }
      op = { type: "addVideo", src, durationSec: probed.durationSec };
      break;
  }

  try {
    const next = applyOp(edl, op);
    stageAssets(next);
    fs.writeFileSync(path.join(artifactsDir(jobId), "edl.json"), JSON.stringify(next, null, 2));
    return NextResponse.json({ edl: next });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

import { Edl } from "../pipeline/types";

/**
 * Placeholder props so the EdlVideo composition can open in Remotion Studio
 * without a job. Real renders pass a job's edl.json via --props; this is
 * never rendered by the pipeline.
 */
export const defaultEdl: Edl = {
  jobId: "studio-preview",
  formatId: "none",
  fps: 30,
  width: 1080,
  height: 1920,
  durationSec: 2,
  video: [
    {
      id: "placeholder",
      blockId: "placeholder",
      src: "clips/hook.mp4",
      srcInSec: 0,
      srcOutSec: 2,
      tlInSec: 0,
      tlOutSec: 2,
      muted: true,
      volume: 1,
    },
  ],
  overlays: [
    {
      id: "placeholder_text",
      component: "TextOverlay",
      params: { text: "EDL preview\nrender with --props", variant: "hook" },
      tlInSec: 0,
      tlOutSec: 2,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    },
  ],
  sfx: [],
  captions: [],
  transitions: [],
  assets: {},
  diagnostics: [],
};

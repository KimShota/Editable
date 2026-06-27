/**
 * A "template" is a proven viral format encoded as data.
 * This object IS the product's value: it holds the structure (block
 * order, durations, what text goes where) that you extracted from a
 * proven reel. To make a new template for another niche, you write a
 * new object like this — you never touch the rendering code.
 *
 * When a USER uses this template, the only things that change are:
 *   - the `clip` filenames (their own footage)
 *   - the text fields (their own content)
 * Everything else — durations, layout, treatment — stays locked.
 * That locked structure is the "proven format" they're renting from you.
 */

export type Block =
  | {
      type: "hook";
      clip: string;
      /** Duration in frames (at this template's fps) — derived from timecode */
      durationInFrames: number;
      /** The painpoint text shown for most of the hook */
      textHook: string;
      /** The call that resolves the hook (e.g. "GO HERE"), hits on the beat */
      resolveText: string;
      /** When (frame, local to this block) the resolveText appears / beat hits */
      resolveAtFrame: number;
    }
  | {
      type: "resource";
      clip: string;
      durationInFrames: number;
      title: string;
      description: string;
    }
  | {
      type: "cta";
      clip: string;
      durationInFrames: number;
      text: string;
    };

export type Template = {
  id: string;
  niche: string;
  fps: number;
  width: number;
  height: number;
  /** Background music / audio for the whole video (user-supplied file) */
  audio?: { src: string };
  blocks: Block[];
};

/**
 * CS-RESOURCES "3 resources for [painpoint]" format.
 * Durations taken from the reference reel's timecodes (HH:MM:SS:FF @ 30fps):
 *   hook        00:00:02:28 -> 2s 28f = 88 frames (2.9333s)
 *   resource-1  00:00:01:23 -> 1s 23f = 53 frames (1.7667s)
 *   resource-2  00:00:01:19 -> 1s 19f = 49 frames (1.6333s)
 *   resource-3  00:00:01:18 -> 1s 18f = 48 frames (1.6000s)
 *   cta         00:00:01:18 -> 1s 18f = 48 frames (1.6000s)
 *   TOTAL: 286 frames = 9.5333s
 * NOTE: if your audio track runs longer than 9.5333s, it will keep playing
 * after the video's last block ends — trim the audio file to match, or
 * adjust block durations so they sum to the audio length.
 * Text fields are filled with the reference's example content as
 * defaults — a user swaps these for their own.
 */
export const csResourcesTemplate: Template = {
  id: "cs-resources-3",
  niche: "CS students",
  fps: 30,
  width: 1080,
  height: 1920,
  audio: { src: "audio/music.mp3" },
  blocks: [
    {
      type: "hook",
      clip: "clips/hook.mp4",
      durationInFrames: 88, // 00:00:02:28
      textHook: "I have NO projects\non my resume",
      resolveText: "GO HERE",
      resolveAtFrame: 64, // 00:02.14 (2.14s @30fps); align to the "okay" beat — adjust by ear/eye
    },
    {
      type: "resource",
      clip: "clips/resource-1.mp4",
      durationInFrames: 53, // 00:00:01:23
      title: "Resource 1 title",
      description: "One-sentence description of resource 1",
    },
    {
      type: "resource",
      clip: "clips/resource-2.mp4",
      durationInFrames: 49, // 00:00:01:19
      title: "Resource 2 title",
      description: "One-sentence description of resource 2",
    },
    {
      type: "resource",
      clip: "clips/resource-3.mp4",
      durationInFrames: 48, // 00:00:01:18
      title: "Resource 3 title",
      description: "One-sentence description of resource 3",
    },
    {
      type: "cta",
      clip: "clips/cta.mp4",
      durationInFrames: 48, // 00:00:01:18
      text: "Follow & Comment \u201CLINKS\u201D for the resources",
    },
  ],
};

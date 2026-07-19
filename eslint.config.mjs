import { config } from "@remotion/eslint-config-flat";

export default [
  ...config,
  {
    // The Remotion ruleset assumes every component is a video composition
    // (native <video>/<img> should be Remotion's own <Video>/<Img>, all
    // animation should run off useCurrentFrame()). Neither applies to the
    // Next.js app under src/app/, which is a regular web page.
    files: ["src/app/**/*.{ts,tsx}"],
    rules: {
      "@remotion/warn-native-media-tag": "off",
      "@remotion/non-pure-animation": "off",
    },
  },
];

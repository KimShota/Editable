import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // A stray lockfile above this repo can make Next guess the wrong
  // workspace root; pin it explicitly.
  turbopack: { root: __dirname },
  experimental: {
    // Every request now passes through src/middleware.ts (added for the
    // Vercel waitlist gate), and Next caps a request body read inside
    // middleware at 10MB by default — silently truncating any raw video
    // upload (api/jobs/[jobId]/assets) past that, which breaks the
    // multipart parse. Raised well past a phone-recorded clip's size.
    // (Renamed from middlewareClientMaxBodySize, deprecated in Next 16.3 —
    // see node_modules/next/dist/docs — same option, new name.)
    proxyClientMaxBodySize: "2gb",
  },
};

export default nextConfig;

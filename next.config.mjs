import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // A stray lockfile above this repo can make Next guess the wrong
  // workspace root; pin it explicitly.
  turbopack: { root: __dirname },
};

export default nextConfig;

import fs from "node:fs";
import type { Storage } from "../storage";
import { consoleSink, type CostSink } from "./ledger";

/**
 * A video's own cost log: every paid call (Claude, Gemini, ElevenLabs,
 * Higgsfield) from reading the source to the final render is appended to
 * brands/<brand>/videos/<card>/costs.jsonl, one JSON line each, and printed.
 * Every CLI step that calls a provider uses this sink, so the file is the whole
 * cost of the video, retries and re-takes included. It is read, never rebuilt.
 */
export const fileCostSink = (storage: Storage, key: string): CostSink => {
  let queue = Promise.resolve();
  return (entry) => {
    void consoleSink(entry);
    // One append at a time: shots are made in parallel.
    queue = queue
      .then(async () => {
        const before = (await storage.exists(key)) ? fs.readFileSync(await storage.localPath(key), "utf8") : "";
        await storage.putBuffer(key, Buffer.from(`${before}${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`));
      })
      .catch((err) => console.warn(`cost log: ${err instanceof Error ? err.message : err}`));
    return queue;
  };
};

import fs from "node:fs";
import type { Storage, StoredObject } from "./storage";

/** JSON in and out of a Storage key. The brand files the CLIs and the app
 *  share are all small JSON documents, so this is the whole I/O vocabulary
 *  `brandRepo` and the plan store need. Parsing into a schema is the
 *  caller's job: these return `unknown`. */

export const readJsonIfExists = async (storage: Storage, key: string): Promise<unknown | null> => {
  if (!(await storage.exists(key))) return null;
  return JSON.parse(fs.readFileSync(await storage.localPath(key), "utf8"));
};

export const readJson = async (storage: Storage, key: string, what = key): Promise<unknown> => {
  const value = await readJsonIfExists(storage, key);
  if (value === null) throw new Error(`no ${what} at ${key}`);
  return value;
};

export const writeJson = (storage: Storage, key: string, value: unknown): Promise<StoredObject> =>
  storage.putBuffer(key, Buffer.from(JSON.stringify(value, null, 2)));

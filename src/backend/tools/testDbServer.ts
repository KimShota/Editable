import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { cleanFixtureJobs, FIXTURE, resetStorage, seedUiFixture } from "./fixtures/uiFixture";
import { makeTestDb } from "./testDb";

/**
 * A throwaway database for browser tests and manual runs: PGlite with every
 * migration applied and the UI fixture seeded, behind a JSON endpoint that
 * `app/lib/db.ts` talks to when KATALAB_TEST_DB_URL is set. The app and the
 * worker are separate processes, so the database has to be a server.
 *
 *   npm run test:db-server -- [--port 4455] [--storage <dir>]
 *
 * Prints `READY <url> <storage dir>` when it can take requests. Never
 * connects to a real database.
 */

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const port = Number(option("--port") ?? process.env.KATALAB_TEST_DB_PORT ?? 4455);
const storageRoot = path.resolve(option("--storage") ?? path.join(os.tmpdir(), "katalab-ui-fixture"));

/** JSON has no bigint (count(*) is one), and the app reads these as numbers anyway. */
const json = (value: unknown): string => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v));

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

/** A fresh database and fixture files. */
const fresh = async () => {
  resetStorage(storageRoot);
  const made = await makeTestDb();
  await seedUiFixture(made.query, storageRoot);
  return made;
};

const main = async () => {
  let current = await fresh();

  const server = http.createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(json(body));
    };
    try {
      if (req.method === "GET" && req.url === "/health") return reply(200, { ok: true });
      if (req.method === "GET" && req.url === "/fixture") return reply(200, { ...FIXTURE, storageRoot });
      if (req.method !== "POST") return reply(404, { error: "not found" });
      // Back to the seeded state, for tests that change data. Users get new
      // ids, so a test logs in again afterwards.
      if (req.url === "/reset") {
        const old = current;
        current = await fresh();
        await old.db.close();
        return reply(200, { rows: [] });
      }
      const body = JSON.parse(await readBody(req)) as { text: string; params?: unknown[] };
      if (req.url === "/query") return reply(200, { rows: (await current.db.query(body.text, body.params ?? [])).rows });
      if (req.url === "/exec") {
        await current.db.exec(body.text);
        return reply(200, { rows: [] });
      }
      return reply(404, { error: "not found" });
    } catch (err) {
      return reply(400, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  const shutdown = () => {
    server.close();
    void current.db.close().finally(() => {
      fs.rmSync(storageRoot, { recursive: true, force: true });
      cleanFixtureJobs(); // the editor jobs the stub producer published outside storage/
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.listen(port, "127.0.0.1", () => console.log(`READY http://127.0.0.1:${port} ${storageRoot}`));
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

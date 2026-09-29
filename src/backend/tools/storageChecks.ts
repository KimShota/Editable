import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertValidKey, getStorage, hashFile, LocalStorage, videoKey } from "../storage";
import { makeChecker } from "./checks";

/**
 * storage.ts checks — the key validation that is the path-traversal
 * defence, and the local driver's contract.
 *
 *   npm run test:storage
 */

const main = async () => {
  const t = makeChecker();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "editable-storage-"));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "editable-storage-src-"));

  try {
    console.log("key validation");
    for (const good of ["a", "videos/ab/abcd.mp4", "x/y-z_1.2/file.name.mov", "A1"]) {
      let ok = true;
      try {
        assertValidKey(good);
      } catch {
        ok = false;
      }
      t.check(`accepts "${good}"`, ok);
    }
    for (const bad of ["", "/abs", "a//b", "a/../b", "..", "../x", "a/./b", "a\\b", ".hidden", "a/.hidden", "a b", "a/\0b", "a/", "x".repeat(513)]) {
      t.throws(`rejects ${JSON.stringify(bad.length > 40 ? bad.slice(0, 20) + "…" : bad)}`, () => assertValidKey(bad), /invalid key/);
    }

    console.log("videoKey");
    const hash = "ab" + "0".repeat(62);
    t.check("shards by the first two hex chars", videoKey(hash, "MP4") === `videos/ab/${hash}.mp4`);
    t.check("accepts a leading dot on the extension", videoKey(hash, ".mov").endsWith(".mov"));
    t.throws("rejects a non-sha256 hash", () => videoKey("nothex", "mp4"), /sha256/);
    t.throws("rejects a hostile extension", () => videoKey(hash, "mp4/../x"), /bad extension/);

    console.log("LocalStorage");
    const storage = new LocalStorage(root);
    const src = path.join(scratch, "in.bin");
    const payload = Buffer.from("hello storage");
    fs.writeFileSync(src, payload);
    const expectedSha = createHash("sha256").update(payload).digest("hex");

    const stored = await storage.putFile("videos/ab/one.bin", src);
    t.check("putFile reports bytes and sha256", stored.bytes === payload.length && stored.sha256 === expectedSha);
    t.check("hashFile agrees with the stored sha256", (await hashFile(src)) === expectedSha);
    t.check("exists after put", await storage.exists("videos/ab/one.bin"));
    t.check("localPath returns a readable file with the same bytes", fs.readFileSync(await storage.localPath("videos/ab/one.bin")).equals(payload));
    t.check("localPath stays under the root", (await storage.localPath("videos/ab/one.bin")).startsWith(root));

    const b = await storage.putBuffer("videos/ab/two.bin", Buffer.from("two"));
    t.check("putBuffer reports bytes", b.bytes === 3);
    t.check("overwriting a key replaces its content", (await storage.putBuffer("videos/ab/two.bin", Buffer.from("three"))).bytes === 5 && fs.readFileSync(await storage.localPath("videos/ab/two.bin"), "utf8") === "three");

    await storage.putBuffer("other/x.bin", Buffer.from("x"));
    t.check("list(prefix) returns sorted keys under it only", JSON.stringify(await storage.list("videos")) === JSON.stringify(["videos/ab/one.bin", "videos/ab/two.bin"]));
    t.check("list('') returns everything", (await storage.list("")).length === 3);
    t.check("list of a missing prefix is empty, not an error", (await storage.list("nope")).length === 0);

    // A crash mid-write leaves a .tmp sibling; it must never be listed as an object.
    fs.writeFileSync(path.join(root, "videos/ab/half.bin.123.tmp"), "partial");
    t.check("in-flight .tmp files are not listed", !(await storage.list("videos")).some((k) => k.endsWith(".tmp")));
    t.check("a put leaves no .tmp behind", !fs.readdirSync(path.join(root, "videos/ab")).some((f) => f.endsWith(".tmp") && !f.startsWith("half")));

    await storage.remove("videos/ab/one.bin");
    t.check("remove deletes", !(await storage.exists("videos/ab/one.bin")));
    await storage.remove("videos/ab/one.bin");
    t.check("removing a missing key is not an error", true);

    await t.rejects("localPath of a missing key fails clearly", () => storage.localPath("videos/ab/one.bin"), /no object/);
    await t.rejects("put with a traversal key is refused", () => storage.putBuffer("../escape.bin", Buffer.from("x")), /invalid key/);
    t.check("the traversal put wrote nothing outside the root", !fs.existsSync(path.join(root, "..", "escape.bin")));
    await t.rejects("exists with a traversal key is refused", () => storage.exists("a/../../etc/passwd"), /invalid key/);
    t.check("publicUrl is null for local disk", storage.publicUrl() === null);

    console.log("getStorage");
    const prevDriver = process.env.STORAGE_DRIVER;
    process.env.STORAGE_DRIVER = "s3";
    t.throws("an unimplemented driver fails loudly", () => getStorage(), /unknown STORAGE_DRIVER/);
    if (prevDriver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = prevDriver;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  t.finish("storage");
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

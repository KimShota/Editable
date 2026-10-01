import "dotenv/config";
import { type BrandIntake, BrandIntakeSchema } from "../brand/intake/schemas";
import { consoleSink } from "../cost/ledger";
import { getStorage } from "../storage";
import { generateMascotConcepts } from "./concepts";
import { buildGrid } from "./grid";
import { designVoice, saveDesignedVoice, textToSpeech } from "../voice/elevenlabs";
import { generateCandidate, generateSheetView, refineCandidate } from "./images";
import { type LockedCharacter, LockedCharacterSchema, type MascotConcept, MascotConceptsSchema, SHEET_VIEWS, type SheetView } from "./schemas";

/**
 * Mascot design for one brand, run by hand in the pilot (M1 day 2). State is
 * files under storage key brands/<brand>/, so every step is inspectable and
 * re-runnable; the onboarding UI drives the same functions later.
 *
 *   npm run character -- concepts   --brand <slug> --intake <storage key> [--product <i>] [--count 5] [--direction "…"]
 *   npm run character -- candidates --brand <slug> [--concepts 0,2] [--variations 1]
 *   npm run character -- refine     --brand <slug> --from <candidate> --note "…" [--ref <image path>]
 *   npm run character -- lock       --brand <slug> --from <candidate> [--views front,happy,…]
 *   npm run character -- voice      --brand <slug> [--description "…"] [--text "…"] [--seed n] [--library <voiceId,…>]
 *   npm run character -- voice-pick --brand <slug> --preview <d0-1> [--name "…"] [--sample "…"]
 *   npm run character -- show       --brand <slug>
 *
 * `voice` designs 3 candidate voices for the locked character from its
 * concept's voice description (each run adds a round d<n>-0..2 to
 * character/voice/), or with --library auditions existing ElevenLabs voices
 * speaking the same text (round d<n>-0..). Voice design needs a paid plan;
 * library voices work on any. `voice-pick` saves a designed one to the
 * account, speaks a sample line, and writes the voice into character.json.
 *
 * Candidates are named c<concept>-v<variation> (or c<concept>-r<n> when
 * refined) and stored as brands/<slug>/character/candidates/<name>.png.
 */

const USAGE = "usage: npm run character -- <concepts|candidates|refine|lock|voice|voice-pick|show> --brand <slug> [options]  (see cli.ts)";

const option = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const required = (args: string[], name: string): string => {
  const v = option(args, name);
  if (!v) throw new Error(`missing ${name}\n${USAGE}`);
  return v;
};

const storage = getStorage();
const readJson = async <T>(key: string, parse: (x: unknown) => T): Promise<T> => {
  const fs = await import("node:fs");
  return parse(JSON.parse(fs.readFileSync(await storage.localPath(key), "utf8")));
};
const writeJson = (key: string, value: unknown) => storage.putBuffer(key, Buffer.from(JSON.stringify(value, null, 2)));

const keys = (brand: string) => {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(brand)) throw new Error(`--brand must be a lowercase slug, got "${brand}"`);
  const root = `brands/${brand}`;
  return {
    intake: `${root}/intake.json`,
    concepts: `${root}/character/concepts.json`,
    candidate: (name: string) => {
      if (!/^c\d+-[vr]\d+$/.test(name)) throw new Error(`candidate names look like c1-v0 or c1-r2, got "${name}"`);
      return `${root}/character/candidates/${name}.png`;
    },
    candidatesDir: `${root}/character/candidates`,
    candidatesGrid: `${root}/character/candidates-grid.png`,
    sheetView: (view: string) => `${root}/character/sheet/${view}.png`,
    sheetGrid: `${root}/character/sheet-grid.png`,
    character: `${root}/character/character.json`,
    voicePreviews: `${root}/character/voice/previews.json`,
    voicePreview: (name: string) => `${root}/character/voice/${name}.mp3`,
    voiceSample: `${root}/character/voice/sample.mp3`,
  };
};

const conceptIndexOf = (candidate: string): number => Number(candidate.match(/^c(\d+)-/)![1]);

const loadConcepts = async (brand: string): Promise<MascotConcept[]> =>
  (await readJson(keys(brand).concepts, (x) => MascotConceptsSchema.parse(x))).concepts;

const printConcept = (c: MascotConcept, i: number) => {
  console.log(`\n[${i}] ${c.name} — ${c.form} (${c.style})`);
  console.log(`    ${c.oneLine}`);
  console.log(`    personality: ${c.personality.join(", ")} · prop: ${c.signatureProp}`);
  console.log(`    catchphrase: "${c.catchphrase}"`);
  console.log(`    voice: ${c.voiceDescription}`);
  console.log(`    videos: ${c.contentAngle}`);
  console.log(`    why: ${c.whyItFits}`);
};

const loadCharacter = async (brand: string): Promise<LockedCharacter> => {
  const k = keys(brand);
  if (!(await storage.exists(k.character))) throw new Error(`no locked character for ${brand}: run lock first`);
  return readJson(k.character, (x) => LockedCharacterSchema.parse(x));
};

/** One auditioned voice: either a voice-design preview (`generatedVoiceId`,
 *  not yet on the account) or an existing library voice (`libraryVoiceId`). */
type VoicePreviewRecord = {
  name: string;
  generatedVoiceId?: string;
  libraryVoiceId?: string;
  key: string;
  description: string;
  durationSecs?: number;
};

/** A line long enough for voice design (100+ characters), in the character's
 *  own words, ending on its catchphrase. */
const defaultVoiceText = (c: MascotConcept): string =>
  `Hi, I'm ${c.name}. I've been watching everything that landed on your desk today, and honestly? ` +
  `Most of it can wait. One thing can't, and it's right here. ${c.catchphrase}`;

const regrid = async (brand: string) => {
  const k = keys(brand);
  const files = (await storage.list(k.candidatesDir)).filter((f) => f.endsWith(".png"));
  const tiles = await Promise.all(files.map(async (f) => ({ path: await storage.localPath(f), label: f.split("/").pop()!.replace(".png", "") })));
  const out = await storage.localPath(k.candidatesDir).catch(() => null);
  if (!out || tiles.length === 0) return;
  const gridPath = out.replace(/candidates$/, "candidates-grid.png");
  buildGrid(tiles, gridPath, 3);
  console.log(`grid: ${gridPath}`);
};

const commands: Record<string, (args: string[]) => Promise<void>> = {
  concepts: async (args) => {
    const brand = required(args, "--brand");
    const k = keys(brand);
    const intake: BrandIntake = await readJson(required(args, "--intake"), (x) => BrandIntakeSchema.parse((x as { intake?: unknown }).intake ?? x));
    await writeJson(k.intake, intake);
    const productIndex = option(args, "--product") ? Number(option(args, "--product")) : undefined;
    const concepts = await generateMascotConcepts(intake, {
      productIndex,
      count: Number(option(args, "--count") ?? 5),
      direction: option(args, "--direction"),
      costSink: consoleSink,
    });
    await writeJson(k.concepts, { concepts });
    concepts.forEach(printConcept);
    console.log(`\nsaved ${k.concepts}`);
  },

  candidates: async (args) => {
    const brand = required(args, "--brand");
    const k = keys(brand);
    const concepts = await loadConcepts(brand);
    const picks = option(args, "--concepts")?.split(",").map(Number) ?? concepts.map((_, i) => i);
    const variations = Number(option(args, "--variations") ?? 1);
    const VARIATION_NOTES = ["", "a slightly different take on proportions and face, same concept", "a bolder, more graphic take, same concept"];
    const jobs = picks.flatMap((ci) => {
      if (!concepts[ci]) throw new Error(`no concept ${ci} (have 0-${concepts.length - 1})`);
      return Array.from({ length: variations }, (_, vi) => ({ ci, vi }));
    });
    // Parallel: each call is ~20-40s and independent.
    await Promise.all(
      jobs.map(async ({ ci, vi }) => {
        const name = `c${ci}-v${vi}`;
        try {
          const bytes = await generateCandidate(concepts[ci], VARIATION_NOTES[vi] || undefined, { costSink: consoleSink, ref: `${brand}/${name}` });
          await storage.putBuffer(k.candidate(name), bytes);
          console.log(`  ✔ ${name} ${concepts[ci].name}`);
        } catch (err) {
          console.log(`  ✘ ${name} ${concepts[ci].name}: ${err instanceof Error ? err.message.slice(0, 300) : err}`);
        }
      }),
    );
    await regrid(brand);
  },

  refine: async (args) => {
    const brand = required(args, "--brand");
    const k = keys(brand);
    const from = required(args, "--from");
    const concepts = await loadConcepts(brand);
    const ci = conceptIndexOf(from);
    const existing = (await storage.list(k.candidatesDir)).filter((f) => f.includes(`/c${ci}-r`)).length;
    const name = `c${ci}-r${existing}`;
    // A feature reference is copied into the brand's storage, so the refine
    // stays reproducible after the original file is gone.
    const refPath = option(args, "--ref");
    let featureRefPath: string | undefined;
    if (refPath) {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const refKey = `brands/${brand}/character/refs/${name}${path.extname(refPath).toLowerCase() || ".png"}`;
      await storage.putBuffer(refKey, fs.readFileSync(refPath));
      featureRefPath = await storage.localPath(refKey);
    }
    const bytes = await refineCandidate(concepts[ci], await storage.localPath(k.candidate(from)), required(args, "--note"), {
      costSink: consoleSink,
      ref: `${brand}/${name}`,
      featureRefPath,
    });
    await storage.putBuffer(k.candidate(name), bytes);
    console.log(`  ✔ ${name} (from ${from})`);
    await regrid(brand);
  },

  lock: async (args) => {
    const brand = required(args, "--brand");
    const k = keys(brand);
    const from = required(args, "--from");
    const concepts = await loadConcepts(brand);
    const concept = concepts[conceptIndexOf(from)];
    const basePath = await storage.localPath(k.candidate(from));
    const views = (option(args, "--views")?.split(",") ?? Object.keys(SHEET_VIEWS)) as SheetView[];
    for (const v of views) if (!(v in SHEET_VIEWS)) throw new Error(`unknown view "${v}" (have ${Object.keys(SHEET_VIEWS).join(", ")})`);

    // Keep views from an earlier lock of the same base, so a re-run only
    // regenerates what was asked for.
    const previous = (await storage.exists(k.character)) ? await readJson(k.character, (x) => LockedCharacterSchema.parse(x)) : null;
    const sheet: Record<string, string> = previous && previous.baseImageKey === k.candidate(from) ? { ...previous.sheet } : {};

    await Promise.all(
      views.map(async (view) => {
        try {
          const bytes = await generateSheetView(concept, basePath, view, { costSink: consoleSink, ref: `${brand}/sheet/${view}` });
          await storage.putBuffer(k.sheetView(view), bytes);
          sheet[view] = k.sheetView(view);
          console.log(`  ✔ ${view}`);
        } catch (err) {
          console.log(`  ✘ ${view}: ${err instanceof Error ? err.message.slice(0, 300) : err}`);
        }
      }),
    );

    // Re-read for the voice: a voice-pick may have finished while the views
    // were generating, and that write must not be lost.
    const latest = (await storage.exists(k.character)) ? await readJson(k.character, (x) => LockedCharacterSchema.parse(x)) : null;
    const character: LockedCharacter = {
      kind: "mascot",
      concept,
      baseImageKey: k.candidate(from),
      sheet,
      lockedAt: new Date().toISOString(),
      voice: latest?.voice ?? null,
    };
    await writeJson(k.character, character);

    const tiles = [{ path: basePath, label: `base (${from})` }];
    for (const view of Object.keys(SHEET_VIEWS)) if (sheet[view]) tiles.push({ path: await storage.localPath(sheet[view]), label: view });
    const gridPath = (await storage.localPath(k.character)).replace(/character\.json$/, "sheet-grid.png");
    buildGrid(tiles, gridPath, 5);
    console.log(`\nlocked ${concept.name}: ${Object.keys(sheet).length} views\nsheet grid: ${gridPath}`);
  },

  voice: async (args) => {
    const brand = required(args, "--brand");
    const k = keys(brand);
    const character = await loadCharacter(brand);
    const description = option(args, "--description") ?? character.concept.voiceDescription;
    const text = option(args, "--text") ?? defaultVoiceText(character.concept);
    const seed = option(args, "--seed") ? Number(option(args, "--seed")) : undefined;

    const records: VoicePreviewRecord[] = (await storage.exists(k.voicePreviews)) ? await readJson(k.voicePreviews, (x) => x as VoicePreviewRecord[]) : [];
    const round = new Set(records.map((r) => r.name.split("-")[0])).size;

    const library = option(args, "--library")?.split(",").filter(Boolean);
    if (library) {
      // One at a time: lower ElevenLabs plans cap concurrent requests at 2.
      for (const [i, voiceId] of library.entries()) {
        const name = `d${round}-${i}`;
        const audio = await textToSpeech(voiceId, text, { costSink: consoleSink, ref: `${brand}/voice/${name}` });
        await storage.putBuffer(k.voicePreview(name), audio);
        records.push({ name, libraryVoiceId: voiceId, key: k.voicePreview(name), description: `library voice ${voiceId}` });
        console.log(`  ✔ ${name}  ${voiceId}  ${await storage.localPath(k.voicePreview(name))}`);
      }
      await writeJson(k.voicePreviews, records);
      console.log(`\ntext: "${text}"`);
      return;
    }

    const previews = await designVoice(description, text, { costSink: consoleSink, ref: `${brand}/voice/d${round}`, seed });
    for (const [i, p] of previews.entries()) {
      const name = `d${round}-${i}`;
      await storage.putBuffer(k.voicePreview(name), p.audio);
      records.push({ name, generatedVoiceId: p.generatedVoiceId, key: k.voicePreview(name), description, durationSecs: p.durationSecs });
      console.log(`  ✔ ${name}  ${p.durationSecs.toFixed(1)}s  ${await storage.localPath(k.voicePreview(name))}`);
    }
    await writeJson(k.voicePreviews, records);
    console.log(`\nvoice: "${description}"\ntext: "${text}"`);
  },

  "voice-pick": async (args) => {
    const brand = required(args, "--brand");
    const k = keys(brand);
    const character = await loadCharacter(brand);
    const records = await readJson(k.voicePreviews, (x) => x as VoicePreviewRecord[]);
    const pick = records.find((r) => r.name === required(args, "--preview"));
    if (!pick) throw new Error(`no voice preview "${option(args, "--preview")}" (have ${records.map((r) => r.name).join(", ")})`);

    const name = option(args, "--name") ?? `${character.concept.name} (${brand})`;
    const saved = pick.libraryVoiceId
      ? { voiceId: pick.libraryVoiceId, name }
      : await saveDesignedVoice({
          generatedVoiceId: pick.generatedVoiceId!,
          name,
          description: pick.description,
          notSelectedIds: records.flatMap((r) => (r !== pick && r.generatedVoiceId ? [r.generatedVoiceId] : [])),
        });
    console.log(`  ✔ ${pick.libraryVoiceId ? "using library" : "saved"} voice ${saved.name} (${saved.voiceId})`);

    const sampleText = option(args, "--sample") ?? `${character.concept.catchphrase}`;
    const sample = await textToSpeech(saved.voiceId, sampleText, { costSink: consoleSink, ref: `${brand}/voice/sample` });
    await storage.putBuffer(k.voiceSample, sample);

    await writeJson(k.character, {
      ...character,
      voice: { provider: "elevenlabs", voiceId: saved.voiceId, name: saved.name, source: pick.libraryVoiceId ? "library" : "designed", sampleKey: k.voiceSample },
    } satisfies LockedCharacter);
    console.log(`  ✔ sample "${sampleText}": ${await storage.localPath(k.voiceSample)}\n\nvoice locked into ${k.character}`);
  },

  show: async (args) => {
    const brand = required(args, "--brand");
    const k = keys(brand);
    if (await storage.exists(k.concepts)) (await loadConcepts(brand)).forEach(printConcept);
    if (await storage.exists(k.character)) {
      const c = await readJson(k.character, (x) => LockedCharacterSchema.parse(x));
      console.log(`\nLOCKED: ${c.concept.name} from ${c.baseImageKey} · views ${Object.keys(c.sheet).join(", ")} · voice ${c.voice ? `${c.voice.name} (${c.voice.voiceId})` : "none"}`);
    }
  },
};

const main = async () => {
  const [command, ...args] = process.argv.slice(2);
  const run = commands[command];
  if (!run) {
    console.error(USAGE);
    process.exit(1);
  }
  await run(args);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

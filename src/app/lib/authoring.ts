import "server-only";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DraftSchema } from "@backend/authoring/schemas";
import { Draft } from "@backend/authoring/types";
import { authoringDir, repoRoot } from "@backend/pipeline/paths";

/**
 * Read-side + status-tracking helpers for the format-authoring pipeline —
 * the authoring analog of lib/jobs.ts. A draft is a directory under
 * authoring/<draftId>/ (no separate database, same filesystem-as-store
 * convention as jobs/artifacts/formats).
 */

const authoringRoot = path.join(repoRoot, "authoring");

const isValidDraftId = (draftId: string): boolean => /^[a-zA-Z0-9._-]+$/.test(draftId);

export const draftExists = (draftId: string): boolean =>
  isValidDraftId(draftId) && fs.existsSync(authoringDir(draftId));

export type AuthoringStage = "ingest" | "analyze" | "synthesize";

export type AuthoringStatus =
  | { status: "idle" }
  | { status: "running"; stage: AuthoringStage; startedAt: string }
  | { status: "done"; startedAt: string; finishedAt: string }
  | { status: "error"; startedAt: string; finishedAt: string; error: string };

const statusPath = (draftId: string): string => path.join(authoringDir(draftId), "authoring-status.json");

export const readAuthoringStatus = (draftId: string): AuthoringStatus => {
  const file = statusPath(draftId);
  if (!fs.existsSync(file)) return { status: "idle" };
  return JSON.parse(fs.readFileSync(file, "utf8"));
};

export const writeAuthoringStatus = (draftId: string, status: AuthoringStatus): void => {
  fs.mkdirSync(authoringDir(draftId), { recursive: true });
  fs.writeFileSync(statusPath(draftId), JSON.stringify(status, null, 2));
};

const draftJsonPath = (draftId: string): string => path.join(authoringDir(draftId), "draft.json");

export const draftFormatExists = (draftId: string): boolean => fs.existsSync(draftJsonPath(draftId));

export const readDraft = (draftId: string): Draft => {
  const raw = JSON.parse(fs.readFileSync(draftJsonPath(draftId), "utf8"));
  const parsed = DraftSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`draft.json for "${draftId}" failed validation:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
};

const ingestSourceUrl = (draftId: string): string => {
  const file = path.join(authoringDir(draftId), "ingest.json");
  if (!fs.existsSync(file)) return "";
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).sourceUrl ?? "";
  } catch {
    return "";
  }
};

export type DraftSummary = {
  id: string;
  sourceUrl: string;
  createdAt: string;
  status: AuthoringStatus;
  formatName: string | null;
};

export const listDrafts = (): DraftSummary[] => {
  if (!fs.existsSync(authoringRoot)) return [];
  return fs
    .readdirSync(authoringRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const createdAt = fs.statSync(authoringDir(d.name)).birthtime.toISOString();
      let formatName: string | null = null;
      if (draftFormatExists(d.name)) {
        try {
          formatName = readDraft(d.name).format.name;
        } catch {
          formatName = null;
        }
      }
      return {
        id: d.name,
        sourceUrl: ingestSourceUrl(d.name),
        createdAt,
        status: readAuthoringStatus(d.name),
        formatName,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};

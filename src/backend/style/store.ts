import type { QueryFn } from "../../app/lib/db";
import { StyleSpec, StyleSpecSchema } from "./schemas";
import { deriveEmbedding, toVectorLiteral } from "./vector";

/**
 * style_specs persistence (db/migrations/012). Every write validates the
 * spec and derives its embedding here, so a row can never hold a spec that
 * doesn't parse or an embedding that disagrees with it.
 */

export type StyleVisibility = "private" | "library";

export type StoredStyleSpec = {
  id: string;
  ownerId: string | null;
  visibility: StyleVisibility;
  spec: StyleSpec;
};

export const saveStyleSpec = async (
  query: QueryFn,
  input: { ownerId: string | null; spec: StyleSpec; visibility?: StyleVisibility },
): Promise<string> => {
  // Parse first: throws with the offending path rather than storing junk.
  const spec = StyleSpecSchema.parse(input.spec);
  // The stored spec never carries its embedding — that lives in the column,
  // derived from the fields, so the two can't drift apart.
  const { embedding: _drop, ...body } = spec;
  void _drop;
  const rows = await query(
    `insert into style_specs (owner_id, source_kind, source_ref, spec, embedding, visibility)
     values ($1, $2, $3, $4::jsonb, $5::vector, $6)
     returning id`,
    [
      input.ownerId,
      spec.source.kind,
      spec.source.ref,
      JSON.stringify(body),
      toVectorLiteral(deriveEmbedding(spec)),
      input.visibility ?? "private",
    ],
  );
  return String(rows[0].id);
};

export const getStyleSpec = async (query: QueryFn, id: string): Promise<StoredStyleSpec | null> => {
  const rows = await query(`select id, owner_id, visibility, spec from style_specs where id = $1`, [id]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: String(row.id),
    ownerId: row.owner_id === null ? null : String(row.owner_id),
    visibility: row.visibility as StyleVisibility,
    spec: StyleSpecSchema.parse(row.spec),
  };
};

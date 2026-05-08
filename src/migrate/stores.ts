/**
 * Postgres-backed store records — replaces the browser-localStorage
 * persistence that used to hold Klaviyo key + Redo JWT + storeId.
 *
 * Why server-side:
 *   - lets diagnostics tooling (e.g. /api/debug/resolve-template) run with
 *     the merchant's key without a human in the loop
 *   - keys survive across browsers / cleared localStorage
 *   - JWT can be rotated in one place when it expires; the next migration
 *     run picks up the new value automatically
 *
 * Threat model: anyone with the basic-auth creds can read every stored
 * key via GET /api/stores/:id. That's intentional — they already have
 * carte blanche via the existing /api/run endpoint.
 */

import { getPool, isDbEnabled } from "./db.js";

export interface StoreRecord {
  id: string;
  name: string;
  merchantSlug: string;
  klaviyoKey: string;
  redoJwt: string | null;
  storeId: string;
  redoServerBase: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastImportedAt: string | null;
}

/** Public listing shape — keys are masked so a casual `gh api` doesn't
 *  splatter them in someone's terminal scrollback. The full record (incl.
 *  unmasked keys) is only returned by getById(). */
export interface StoreSummary {
  id: string;
  name: string;
  merchantSlug: string;
  storeId: string;
  hasKlaviyoKey: boolean;
  hasRedoJwt: boolean;
  jwtExpiresAt: string | null;
  klaviyoKeyMasked: string;
  redoJwtMasked: string | null;
  redoServerBase: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastImportedAt: string | null;
}

function rowToRecord(row: any): StoreRecord {
  return {
    id: row.id,
    name: row.name,
    merchantSlug: row.merchant_slug,
    klaviyoKey: row.klaviyo_key,
    redoJwt: row.redo_jwt ?? null,
    storeId: row.store_id,
    redoServerBase: row.redo_server_base ?? null,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at?.toISOString?.() ?? String(row.created_at),
    updatedAt: row.updated_at?.toISOString?.() ?? String(row.updated_at),
    lastImportedAt:
      row.last_imported_at?.toISOString?.() ??
      (row.last_imported_at ? String(row.last_imported_at) : null),
  };
}

function maskKey(v: string | null | undefined): string {
  if (!v) return "—";
  if (v.length <= 8) return "•".repeat(v.length);
  return v.slice(0, 4) + "…" + v.slice(-4);
}

function decodeJwtExp(token: string | null): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    let s = parts[1];
    let pad = s.length % 4;
    if (pad === 2) s += "==";
    else if (pad === 3) s += "=";
    else if (pad === 1) return null;
    const norm = s.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(norm, "base64").toString("utf8");
    const payload = JSON.parse(json);
    if (typeof payload.exp !== "number") return null;
    return new Date(payload.exp * 1000).toISOString();
  } catch {
    return null;
  }
}

export function toSummary(rec: StoreRecord): StoreSummary {
  return {
    id: rec.id,
    name: rec.name,
    merchantSlug: rec.merchantSlug,
    storeId: rec.storeId,
    hasKlaviyoKey: Boolean(rec.klaviyoKey),
    hasRedoJwt: Boolean(rec.redoJwt),
    jwtExpiresAt: decodeJwtExp(rec.redoJwt),
    klaviyoKeyMasked: maskKey(rec.klaviyoKey),
    redoJwtMasked: rec.redoJwt ? maskKey(rec.redoJwt) : null,
    redoServerBase: rec.redoServerBase,
    createdBy: rec.createdBy,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    lastImportedAt: rec.lastImportedAt,
  };
}

export async function listStores(): Promise<StoreRecord[]> {
  if (!isDbEnabled()) return [];
  const r = await getPool().query(
    `SELECT * FROM stores ORDER BY name ASC`,
  );
  return r.rows.map(rowToRecord);
}

export async function getStoreById(id: string): Promise<StoreRecord | null> {
  if (!isDbEnabled()) return null;
  const r = await getPool().query(`SELECT * FROM stores WHERE id = $1`, [id]);
  if (r.rowCount === 0) return null;
  return rowToRecord(r.rows[0]);
}

export async function getStoreBySlug(
  slug: string,
): Promise<StoreRecord | null> {
  if (!isDbEnabled()) return null;
  const r = await getPool().query(
    `SELECT * FROM stores WHERE merchant_slug = $1`,
    [slug],
  );
  if (r.rowCount === 0) return null;
  return rowToRecord(r.rows[0]);
}

export interface CreateStoreInput {
  id?: string; // server generates if omitted
  name: string;
  merchantSlug: string;
  klaviyoKey: string;
  redoJwt?: string | null;
  storeId: string;
  redoServerBase?: string | null;
  createdBy?: string | null;
}

export async function createStore(
  input: CreateStoreInput,
): Promise<StoreRecord> {
  if (!isDbEnabled()) throw new Error("DB not enabled — createStore unavailable");
  const id = input.id ?? `str_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const r = await getPool().query(
    `INSERT INTO stores
       (id, name, merchant_slug, klaviyo_key, redo_jwt, store_id, redo_server_base, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      id,
      input.name,
      input.merchantSlug,
      input.klaviyoKey,
      input.redoJwt ?? null,
      input.storeId,
      input.redoServerBase ?? null,
      input.createdBy ?? null,
    ],
  );
  return rowToRecord(r.rows[0]);
}

export interface UpdateStoreInput {
  name?: string;
  merchantSlug?: string;
  klaviyoKey?: string;
  redoJwt?: string | null;
  storeId?: string;
  redoServerBase?: string | null;
  touchLastImported?: boolean;
}

export async function updateStore(
  id: string,
  patch: UpdateStoreInput,
): Promise<StoreRecord | null> {
  if (!isDbEnabled()) return null;
  // Build a dynamic UPDATE so callers can patch a single field (e.g. just
  // the JWT after expiry) without re-sending the whole record. Only
  // explicitly-provided keys are touched.
  const sets: string[] = [];
  const args: any[] = [];
  let n = 1;
  if (patch.name !== undefined) { sets.push(`name = $${n++}`); args.push(patch.name); }
  if (patch.merchantSlug !== undefined) { sets.push(`merchant_slug = $${n++}`); args.push(patch.merchantSlug); }
  if (patch.klaviyoKey !== undefined) { sets.push(`klaviyo_key = $${n++}`); args.push(patch.klaviyoKey); }
  if (patch.redoJwt !== undefined) { sets.push(`redo_jwt = $${n++}`); args.push(patch.redoJwt); }
  if (patch.storeId !== undefined) { sets.push(`store_id = $${n++}`); args.push(patch.storeId); }
  if (patch.redoServerBase !== undefined) { sets.push(`redo_server_base = $${n++}`); args.push(patch.redoServerBase); }
  if (patch.touchLastImported) { sets.push(`last_imported_at = NOW()`); }
  // Always bump updated_at so the UI can show "edited 2 min ago".
  sets.push(`updated_at = NOW()`);
  if (sets.length === 1) {
    // Only updated_at would change — caller passed an empty patch. No-op.
    return await getStoreById(id);
  }
  args.push(id);
  const r = await getPool().query(
    `UPDATE stores SET ${sets.join(", ")} WHERE id = $${n} RETURNING *`,
    args,
  );
  if (r.rowCount === 0) return null;
  return rowToRecord(r.rows[0]);
}

export async function deleteStore(id: string): Promise<boolean> {
  if (!isDbEnabled()) return false;
  const r = await getPool().query(`DELETE FROM stores WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Persistence layer for imported items — the flat list of templates and
 * flows that have been imported into Redo, scoped per store.
 *
 * Why a separate table (vs. scanning job events): the assist view needs a
 * cheap "what's been imported for this store" query, deduped by item id
 * across re-imports. Walking job_events for that on every page load is
 * expensive and makes the read path clunky. This table is denormalized
 * write-once-per-import so reads are a single indexed scan.
 *
 * Writes are best-effort. If the DB is unavailable the row is dropped and
 * the import still succeeds — the assist view simply won't see that item
 * until a future import re-records it.
 */

import { getPool, isDbEnabled } from "./db.js";

export type ItemType = "email" | "flow";

export interface ImportedItemInput {
  storeId: string;
  storeName: string;
  jobId: string;
  itemId: string;
  itemType: ItemType;
  name: string;
  /**
   * How many individual emails this import represents — 1 for a single
   * email/campaign variant, N for a flow that ships N emails. Drives the
   * "hours saved" tally; defaults to 1 when omitted.
   */
  emailCount?: number;
}

export interface AssistStoreRow {
  storeId: string;
  storeName: string;
  lastImportedAt: string;
  itemCount: number;
  /**
   * Completion stats scoped to the requesting assistant. Only populated
   * when the request specifies `?as=<name>`; otherwise both are 0/null.
   * `mineComplete` lets the UI gray out a card when this assistant has
   * checked off everything for the brand.
   */
  myDoneCount: number;
  mineComplete: boolean;
  /** Has this assistant written any note for this brand? — used by the
   *  "Mine | All" filter on the brand picker. */
  myEngaged: boolean;
}

export interface AssistItemRow {
  itemId: string;
  itemType: ItemType;
  name: string;
  importedAt: string;
  latestJobId: string;
  /** Note pulled from jobs.notes[itemId] for the latestJobId. */
  note: { text: string; author: string | null; savedAt: string | null } | null;
  /** True when the requesting assistant has checked this item off. False
   *  when no `?as=` param was provided. */
  done: boolean;
}

/**
 * Insert an imported item row. Idempotent on (store_id, item_id, job_id) —
 * the same item recorded twice in one job won't duplicate.
 */
export function recordImportedItem(input: ImportedItemInput): void {
  if (!isDbEnabled()) return;
  const emailCount = Math.max(1, Math.floor(input.emailCount ?? 1));
  getPool()
    .query(
      `INSERT INTO imported_items
         (store_id, store_name, job_id, item_id, item_type, name, state, email_count)
       VALUES ($1, $2, $3, $4, $5, $6, 'imported', $7)
       ON CONFLICT (store_id, item_id, job_id) DO NOTHING`,
      [
        input.storeId,
        input.storeName,
        input.jobId,
        input.itemId,
        input.itemType,
        input.name,
        emailCount,
      ],
    )
    .catch((err) => console.warn("[imported-items] insert failed:", err));
}

/**
 * Sum of email_count across all successful imports — drives the
 * "Hours saved: X" header counter. Hours = ceil(emails * 20 / 60).
 */
export async function getTotalEmailsImported(): Promise<number> {
  if (!isDbEnabled()) return 0;
  try {
    const { rows } = await getPool().query(
      `SELECT COALESCE(SUM(email_count), 0)::bigint AS total
         FROM imported_items
        WHERE state = 'imported'`,
    );
    return Number(rows[0]?.total ?? 0);
  } catch (e) {
    console.warn("[imported-items] getTotalEmailsImported failed:", e);
    return 0;
  }
}

/** Convert an email count to ceiling-rounded hours. 20 minutes per email. */
export function emailsToHours(emails: number): number {
  return Math.ceil((emails * 20) / 60);
}

/**
 * List stores that have ≥1 imported item. Sorted by most-recent import
 * first. The assist UI uses this to render the brand-card grid.
 *
 * When `assistant` is provided, each row also carries `myDoneCount`,
 * `mineComplete`, and `myEngaged` — the brand picker uses these to gray
 * out completed cards and to power the "Mine | All" filter.
 */
export async function listAssistStores(
  assistant?: string,
): Promise<AssistStoreRow[]> {
  if (!isDbEnabled()) return [];
  const as = assistant && assistant.trim() !== "" ? assistant.trim() : null;
  try {
    if (!as) {
      // Fast path: no assistant context, skip the joins.
      const { rows } = await getPool().query(
        `SELECT
           store_id,
           MAX(store_name) AS store_name,
           MAX(imported_at) AS last_imported_at,
           COUNT(DISTINCT item_id) AS item_count
         FROM imported_items
         WHERE state = 'imported'
         GROUP BY store_id
         ORDER BY MAX(imported_at) DESC`,
      );
      return rows.map((r: any) => ({
        storeId: r.store_id,
        storeName: r.store_name,
        lastImportedAt:
          r.last_imported_at instanceof Date
            ? r.last_imported_at.toISOString()
            : String(r.last_imported_at),
        itemCount: Number(r.item_count),
        myDoneCount: 0,
        mineComplete: false,
        myEngaged: false,
      }));
    }
    // With-assistant path: join completions + notes-by-author so we can
    // compute per-store {done count, complete?, engaged?}.
    const { rows } = await getPool().query(
      `WITH items AS (
         SELECT store_id,
                MAX(store_name) AS store_name,
                MAX(imported_at) AS last_imported_at,
                COUNT(DISTINCT item_id) AS item_count
           FROM imported_items
          WHERE state = 'imported'
          GROUP BY store_id
       ),
       my_done AS (
         SELECT store_id, COUNT(DISTINCT item_id) AS done_count
           FROM assist_completions
          WHERE assistant = $1
          GROUP BY store_id
       ),
       my_notes AS (
         SELECT j.id AS job_id,
                ii.store_id,
                COUNT(*) AS note_count
           FROM jobs j
           CROSS JOIN LATERAL jsonb_each(j.notes) AS n(item_id, value)
           JOIN imported_items ii
             ON ii.job_id = j.id AND ii.item_id = n.item_id
          WHERE jsonb_typeof(value) = 'object'
            AND value->>'author' = $1
          GROUP BY j.id, ii.store_id
       )
       SELECT i.store_id,
              i.store_name,
              i.last_imported_at,
              i.item_count,
              COALESCE(d.done_count, 0) AS done_count,
              CASE WHEN EXISTS (SELECT 1 FROM my_notes mn WHERE mn.store_id = i.store_id) THEN true ELSE false END AS engaged
         FROM items i
         LEFT JOIN my_done d ON d.store_id = i.store_id
        ORDER BY i.last_imported_at DESC`,
      [as],
    );
    return rows.map((r: any) => {
      const itemCount = Number(r.item_count);
      const myDoneCount = Number(r.done_count);
      return {
        storeId: r.store_id,
        storeName: r.store_name,
        lastImportedAt:
          r.last_imported_at instanceof Date
            ? r.last_imported_at.toISOString()
            : String(r.last_imported_at),
        itemCount,
        myDoneCount,
        mineComplete: itemCount > 0 && myDoneCount >= itemCount,
        myEngaged: Boolean(r.engaged) || myDoneCount > 0,
      };
    });
  } catch (e) {
    console.warn("[imported-items] listAssistStores failed:", e);
    return [];
  }
}

/**
 * Per-store flat list, deduped by item_id. For each item, picks the most
 * recent successful import and joins jobs.notes for that job's note.
 * Returns the store name alongside so the UI can render the page header
 * even on a direct deep-link without first loading the stores list.
 *
 * When `assistant` is provided, each item's `done` reflects whether
 * that assistant has checked it off in `assist_completions`.
 */
export async function listAssistItemsForStore(
  storeId: string,
  assistant?: string,
): Promise<{ storeName: string | null; items: AssistItemRow[] }> {
  if (!isDbEnabled()) return { storeName: null, items: [] };
  const as = assistant && assistant.trim() !== "" ? assistant.trim() : null;
  try {
    const { rows } = await getPool().query(
      `WITH latest AS (
         SELECT DISTINCT ON (item_id)
           item_id,
           item_type,
           name,
           imported_at,
           job_id,
           store_name
         FROM imported_items
         WHERE store_id = $1
           AND state = 'imported'
         ORDER BY item_id, imported_at DESC
       )
       SELECT l.item_id, l.item_type, l.name, l.imported_at, l.job_id,
              l.store_name,
              j.notes,
              CASE WHEN $2::text IS NOT NULL AND EXISTS (
                SELECT 1 FROM assist_completions c
                 WHERE c.store_id = $1 AND c.item_id = l.item_id AND c.assistant = $2
              ) THEN true ELSE false END AS done
         FROM latest l
         LEFT JOIN jobs j ON j.id = l.job_id
        ORDER BY l.imported_at DESC`,
      [storeId, as],
    );
    const storeName = rows[0]?.store_name ?? null;
    const items = rows.map((r: any) => {
      const noteRaw = r.notes && typeof r.notes === "object"
        ? r.notes[r.item_id]
        : undefined;
      let note: AssistItemRow["note"] = null;
      if (typeof noteRaw === "string" && noteRaw.length > 0) {
        note = { text: noteRaw, author: null, savedAt: null };
      } else if (noteRaw && typeof noteRaw === "object" && typeof noteRaw.text === "string") {
        note = {
          text: noteRaw.text,
          author: typeof noteRaw.author === "string" ? noteRaw.author : null,
          savedAt: typeof noteRaw.savedAt === "string" ? noteRaw.savedAt : null,
        };
      }
      return {
        itemId: r.item_id,
        itemType: r.item_type as ItemType,
        name: r.name,
        importedAt:
          r.imported_at instanceof Date
            ? r.imported_at.toISOString()
            : String(r.imported_at),
        latestJobId: r.job_id,
        note,
        done: Boolean(r.done),
      };
    });
    return { storeName, items };
  } catch (e) {
    console.warn("[imported-items] listAssistItemsForStore failed:", e);
    return { storeName: null, items: [] };
  }
}

/**
 * Toggle the per-assistant "done" state for an item. Inserts a row when
 * `done` is true, deletes it when false. Idempotent on both directions.
 */
export async function setAssistDone(
  storeId: string,
  itemId: string,
  assistant: string,
  done: boolean,
): Promise<void> {
  if (!isDbEnabled()) return;
  const as = assistant.trim();
  if (!as) return;
  try {
    if (done) {
      await getPool().query(
        `INSERT INTO assist_completions (store_id, item_id, assistant)
         VALUES ($1, $2, $3)
         ON CONFLICT (store_id, item_id, assistant) DO NOTHING`,
        [storeId, itemId, as],
      );
    } else {
      await getPool().query(
        `DELETE FROM assist_completions
          WHERE store_id = $1 AND item_id = $2 AND assistant = $3`,
        [storeId, itemId, as],
      );
    }
  } catch (e) {
    console.warn("[imported-items] setAssistDone failed:", e);
  }
}

/**
 * Read a user's saved brand-card ordering. Returns store ids in the
 * order the user dragged them. Stores not in the table are absent;
 * the caller's responsibility to append them after the saved order.
 */
export async function getCardOrder(userName: string): Promise<string[]> {
  if (!isDbEnabled()) return [];
  const u = userName.trim();
  if (!u) return [];
  try {
    const { rows } = await getPool().query(
      `SELECT store_id FROM card_priority
        WHERE user_name = $1
        ORDER BY position ASC`,
      [u],
    );
    return rows.map((r: any) => r.store_id);
  } catch (e) {
    console.warn("[imported-items] getCardOrder failed:", e);
    return [];
  }
}

/**
 * Replace a user's saved ordering. Deletes existing rows and inserts
 * the new sequence in one transaction so the table never reflects a
 * half-applied reorder.
 */
export async function setCardOrder(
  userName: string,
  storeIds: string[],
): Promise<void> {
  if (!isDbEnabled()) return;
  const u = userName.trim();
  if (!u) return;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM card_priority WHERE user_name = $1`, [u]);
    for (let i = 0; i < storeIds.length; i++) {
      await client.query(
        `INSERT INTO card_priority (user_name, store_id, position)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_name, store_id) DO UPDATE SET position = EXCLUDED.position`,
        [u, storeIds[i], i],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    console.warn("[imported-items] setCardOrder failed:", e);
  } finally {
    client.release();
  }
}

/**
 * Resolve the latest job id that imported a given (storeId, itemId). The
 * assist note-write endpoint uses this to pick which job's notes JSONB to
 * upsert into.
 */
export async function findLatestJobForItem(
  storeId: string,
  itemId: string,
): Promise<string | null> {
  if (!isDbEnabled()) return null;
  try {
    const { rows } = await getPool().query(
      `SELECT job_id FROM imported_items
        WHERE store_id = $1 AND item_id = $2 AND state = 'imported'
        ORDER BY imported_at DESC
        LIMIT 1`,
      [storeId, itemId],
    );
    return rows[0]?.job_id ?? null;
  } catch (e) {
    console.warn("[imported-items] findLatestJobForItem failed:", e);
    return null;
  }
}

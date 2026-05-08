/**
 * GET /api/assist/stores?t=<token>&as=<name>
 *
 * Returns the brand-card grid data: one row per store with at least one
 * imported item. When `?as=` is provided, each row also carries
 * per-assistant completion stats (myDoneCount, mineComplete, myEngaged)
 * so the UI can gray out completed cards and power the Mine|All filter.
 *
 * SQL lifted from src/migrate/imported-items.ts listAssistStores().
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "../_lib/db.js";
import { readAs, requireToken } from "../_lib/auth.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!requireToken(req, res)) return;
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }
  const as = readAs(req);
  const q = sql();
  try {
    const rows = as
      ? (await q`
          WITH items AS (
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
             WHERE assistant = ${as}
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
               AND value->>'author' = ${as}
             GROUP BY j.id, ii.store_id
          )
          SELECT i.store_id,
                 i.store_name,
                 i.last_imported_at,
                 i.item_count,
                 COALESCE(d.done_count, 0) AS done_count,
                 CASE WHEN EXISTS (
                   SELECT 1 FROM my_notes mn WHERE mn.store_id = i.store_id
                 ) THEN true ELSE false END AS engaged
            FROM items i
            LEFT JOIN my_done d ON d.store_id = i.store_id
           ORDER BY i.last_imported_at DESC
        `)
      : (await q`
          SELECT store_id,
                 MAX(store_name) AS store_name,
                 MAX(imported_at) AS last_imported_at,
                 COUNT(DISTINCT item_id) AS item_count
            FROM imported_items
           WHERE state = 'imported'
           GROUP BY store_id
           ORDER BY MAX(imported_at) DESC
        `);

    const stores = rows.map((r: any) => {
      const itemCount = Number(r.item_count);
      const myDoneCount = Number(r.done_count ?? 0);
      return {
        storeId: r.store_id,
        storeName: r.store_name,
        lastImportedAt:
          r.last_imported_at instanceof Date
            ? r.last_imported_at.toISOString()
            : String(r.last_imported_at),
        itemCount,
        myDoneCount,
        mineComplete: as ? itemCount > 0 && myDoneCount >= itemCount : false,
        myEngaged: as ? Boolean(r.engaged) || myDoneCount > 0 : false,
      };
    });
    res.json({ stores });
  } catch (e: any) {
    console.warn("[assist/stores] query failed:", e?.message ?? e);
    // 503 because the most likely cause is a missing table — Replit hasn't
    // run migration 004/006 yet. The UI shows "Loading…" indefinitely
    // otherwise; we want a clear failure mode.
    res.status(503).json({ error: "database unavailable", detail: e?.message });
  }
}

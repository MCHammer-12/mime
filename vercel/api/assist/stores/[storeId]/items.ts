/**
 * GET /api/assist/stores/[storeId]/items?t=<token>&as=<name>
 *
 * Per-store flat list of imported items, deduped by item_id. Each row
 * carries the latest job's note (legacy string OR structured) and the
 * requesting assistant's `done` flag.
 *
 * SQL lifted from src/migrate/imported-items.ts listAssistItemsForStore().
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { coerceNote, sql } from "../../../_lib/db.js";
import { readAs, requireToken } from "../../../_lib/auth.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!requireToken(req, res)) return;
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }
  const storeId = String(req.query.storeId ?? "").trim();
  if (!storeId) return res.status(400).json({ error: "storeId required" });
  const as = readAs(req);
  const q = sql();
  try {
    const rows = await q`
      WITH latest AS (
        SELECT DISTINCT ON (item_id)
          item_id, item_type, name, imported_at, job_id, store_name
        FROM imported_items
        WHERE store_id = ${storeId}
          AND state = 'imported'
        ORDER BY item_id, imported_at DESC
      )
      SELECT l.item_id, l.item_type, l.name, l.imported_at, l.job_id,
             l.store_name,
             j.notes,
             CASE WHEN ${as}::text IS NOT NULL AND EXISTS (
               SELECT 1 FROM assist_completions c
                WHERE c.store_id = ${storeId}
                  AND c.item_id = l.item_id
                  AND c.assistant = ${as}
             ) THEN true ELSE false END AS done
        FROM latest l
        LEFT JOIN jobs j ON j.id = l.job_id
       ORDER BY l.imported_at DESC
    `;
    const storeName = rows[0]?.store_name ?? null;
    const items = rows.map((r: any) => {
      const noteRaw =
        r.notes && typeof r.notes === "object" ? r.notes[r.item_id] : undefined;
      return {
        itemId: r.item_id,
        itemType: r.item_type,
        name: r.name,
        importedAt:
          r.imported_at instanceof Date
            ? r.imported_at.toISOString()
            : String(r.imported_at),
        latestJobId: r.job_id,
        note: coerceNote(noteRaw),
        done: Boolean(r.done),
      };
    });
    res.json({ storeName, items });
  } catch (e: any) {
    console.warn("[assist/items] query failed:", e?.message ?? e);
    res.status(503).json({ error: "database unavailable", detail: e?.message });
  }
}

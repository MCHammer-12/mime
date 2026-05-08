/**
 * POST /api/assist/stores/[storeId]/items/[itemId]/done?t=<token>
 * Body: { done: boolean, author: string }
 *
 * Toggle the per-assistant "done" flag on an item. `done=true` upserts
 * a row in assist_completions; `done=false` deletes it. Idempotent.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readJsonBody, sql } from "../../../../../_lib/db.js";
import { requireToken } from "../../../../../_lib/auth.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!requireToken(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  const storeId = String(req.query.storeId ?? "").trim();
  const itemId = String(req.query.itemId ?? "").trim();
  if (!storeId || !itemId) {
    return res.status(400).json({ error: "storeId and itemId required" });
  }
  const body = readJsonBody(req.body);
  const done = body.done === true;
  const author = typeof body.author === "string" ? body.author.trim() : "";
  if (!author) {
    return res.status(400).json({ error: "author required to mark done" });
  }
  const q = sql();
  try {
    if (done) {
      await q`
        INSERT INTO assist_completions (store_id, item_id, assistant)
        VALUES (${storeId}, ${itemId}, ${author})
        ON CONFLICT (store_id, item_id, assistant) DO NOTHING
      `;
    } else {
      await q`
        DELETE FROM assist_completions
         WHERE store_id = ${storeId}
           AND item_id = ${itemId}
           AND assistant = ${author}
      `;
    }
    res.json({ ok: true, done });
  } catch (e: any) {
    console.warn("[assist/done] update failed:", e?.message ?? e);
    res.status(500).json({ error: "save failed", detail: e?.message });
  }
}

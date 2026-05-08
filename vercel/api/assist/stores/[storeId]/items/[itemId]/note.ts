/**
 * POST /api/assist/stores/[storeId]/items/[itemId]/note?t=<token>
 * Body: { note: string, author?: string }
 *
 * Upsert a note attributed to `author`. Empty `note` clears the entry.
 * Stored in jobs.notes JSONB on the latest job that imported this item —
 * same shape the Replit admin path writes, so notes round-trip cleanly
 * back to the Toby troubleshoot panel.
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
  const noteText = typeof body.note === "string" ? body.note : "";
  const author = typeof body.author === "string" ? body.author.trim() : "";
  const q = sql();

  try {
    const jobRows = await q`
      SELECT job_id FROM imported_items
       WHERE store_id = ${storeId}
         AND item_id = ${itemId}
         AND state = 'imported'
       ORDER BY imported_at DESC
       LIMIT 1
    `;
    if (jobRows.length === 0) {
      return res.status(404).json({ error: "no imported item matching that id" });
    }
    const jobId = jobRows[0].job_id;

    if (noteText.trim() === "") {
      await q`UPDATE jobs SET notes = notes - ${itemId} WHERE id = ${jobId}`;
      return res.json({ ok: true, note: null });
    }
    const savedAt = new Date().toISOString();
    const stored = author
      ? { text: noteText, author, savedAt }
      : { text: noteText, savedAt };
    await q`
      UPDATE jobs
         SET notes = jsonb_set(
           COALESCE(notes, '{}'::jsonb),
           ARRAY[${itemId}],
           ${JSON.stringify(stored)}::jsonb,
           true
         )
       WHERE id = ${jobId}
    `;
    res.json({
      ok: true,
      note: { text: noteText, author: author || null, savedAt },
    });
  } catch (e: any) {
    console.warn("[assist/note] update failed:", e?.message ?? e);
    res.status(500).json({ error: "save failed", detail: e?.message });
  }
}

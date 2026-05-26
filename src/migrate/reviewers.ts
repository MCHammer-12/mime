/**
 * Reviewer records. External (non-Redo, non-Replit) people who get a
 * per-reviewer URL token to access the public-facing review deploy
 * (MIME_SURFACE=public_review).
 *
 * Auth flow:
 *   1. Admin INSERTs a row (psql or admin endpoint, Phase 1 stretch).
 *   2. Admin shares https://<public-deploy>/r/<token>/ with the reviewer.
 *   3. /r/<token>/ handshake looks up the row by token, sets a HttpOnly
 *      `reviewer_token` cookie, redirects to /dashboard.
 *   4. requireReviewer() in server.ts reads the cookie and looks up the
 *      reviewer for every /api/r/* call. Disabled rows 401.
 *
 * Revocation: set disabled_at on the row. The reviewer's URL stops
 * working on the next request — no need to delete the row, so old jobs
 * the reviewer left notes on still attribute correctly.
 */

import { randomBytes } from "node:crypto";
import { getPool, isDbEnabled } from "./db.js";

export interface ReviewerRecord {
  id: string;
  name: string;
  token: string;
  email: string | null;
  createdAt: string;
  disabledAt: string | null;
}

function rowToRecord(row: any): ReviewerRecord {
  return {
    id: row.id,
    name: row.name,
    token: row.token,
    email: row.email ?? null,
    createdAt: row.created_at?.toISOString?.() ?? String(row.created_at),
    disabledAt:
      row.disabled_at?.toISOString?.() ??
      (row.disabled_at ? String(row.disabled_at) : null),
  };
}

/** Random 32-byte URL-safe token. Long enough that guessing isn't a
 *  concern; the URL itself is the credential. */
export function generateReviewerToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function listReviewers(): Promise<ReviewerRecord[]> {
  if (!isDbEnabled()) return [];
  const { rows } = await getPool().query(
    `SELECT id, name, token, email, created_at, disabled_at
       FROM reviewers
      ORDER BY created_at DESC`,
  );
  return rows.map(rowToRecord);
}

export async function getReviewerById(id: string): Promise<ReviewerRecord | null> {
  if (!isDbEnabled()) return null;
  const { rows } = await getPool().query(
    `SELECT id, name, token, email, created_at, disabled_at
       FROM reviewers
      WHERE id = $1`,
    [id],
  );
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Token lookup is the hot path — requireReviewer() calls this on every
 *  /api/r/* request. Returns null for unknown tokens AND for disabled
 *  reviewers so the caller treats both as "no auth". */
export async function getReviewerByToken(
  token: string,
): Promise<ReviewerRecord | null> {
  if (!isDbEnabled()) return null;
  if (!token) return null;
  const { rows } = await getPool().query(
    `SELECT id, name, token, email, created_at, disabled_at
       FROM reviewers
      WHERE token = $1
        AND disabled_at IS NULL`,
    [token],
  );
  return rows[0] ? rowToRecord(rows[0]) : null;
}

export async function createReviewer(input: {
  id: string;
  name: string;
  email?: string | null;
  token?: string;
}): Promise<ReviewerRecord> {
  if (!isDbEnabled()) throw new Error("DB not enabled");
  const token = input.token ?? generateReviewerToken();
  const { rows } = await getPool().query(
    `INSERT INTO reviewers (id, name, token, email)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, token, email, created_at, disabled_at`,
    [input.id, input.name, token, input.email ?? null],
  );
  return rowToRecord(rows[0]);
}

export async function disableReviewer(id: string): Promise<void> {
  if (!isDbEnabled()) return;
  await getPool().query(
    `UPDATE reviewers SET disabled_at = NOW() WHERE id = $1`,
    [id],
  );
}

export async function enableReviewer(id: string): Promise<void> {
  if (!isDbEnabled()) return;
  await getPool().query(
    `UPDATE reviewers SET disabled_at = NULL WHERE id = $1`,
    [id],
  );
}

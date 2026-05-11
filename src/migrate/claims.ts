/**
 * Admin identity claims. Each of the allowed admin users (Austin, Michael)
 * can be claimed once — the first browser to pick that name via the
 * identity modal binds the slot to themselves via a random claim_token
 * mirrored into an HttpOnly cookie.
 *
 * After both slots are claimed, no new browser can authenticate as either
 * user — they can still load the admin SPA at the obscure URL but every
 * API call requireAdmin gates on returns 401.
 *
 * The DB is source of truth. The cookie is the proof a browser presents.
 * Mismatches mean "someone else already owns this identity".
 */

import { randomBytes } from "node:crypto";
import { getPool, isDbEnabled } from "./db.js";

export interface ClaimStatus {
  /** Which slots have been claimed already. The identity modal disables
   *  taken options unless the current browser's claim cookie matches. */
  claimedUsers: string[];
  /** When the requesting browser has a valid claim, this is the user
   *  it owns (Austin / Michael). null otherwise. */
  myClaim: string | null;
}

/**
 * Look up which user, if any, this browser's claim_token resolves to.
 * Returns null when the cookie is missing or doesn't match any row.
 */
export async function userForClaimToken(
  token: string | null,
): Promise<string | null> {
  if (!isDbEnabled() || !token) return null;
  try {
    const { rows } = await getPool().query(
      `SELECT user_name FROM admin_claims WHERE claim_token = $1`,
      [token],
    );
    return rows[0]?.user_name ?? null;
  } catch (e) {
    console.warn("[claims] userForClaimToken failed:", e);
    return null;
  }
}

/** Snapshot of which admin slots are currently taken. */
export async function getClaimStatus(
  token: string | null,
): Promise<ClaimStatus> {
  if (!isDbEnabled()) return { claimedUsers: [], myClaim: null };
  try {
    const { rows } = await getPool().query(
      `SELECT user_name, claim_token FROM admin_claims`,
    );
    const claimedUsers: string[] = [];
    let myClaim: string | null = null;
    for (const r of rows) {
      claimedUsers.push(r.user_name);
      if (token && r.claim_token === token) myClaim = r.user_name;
    }
    return { claimedUsers, myClaim };
  } catch (e) {
    console.warn("[claims] getClaimStatus failed:", e);
    return { claimedUsers: [], myClaim: null };
  }
}

export type ClaimOutcome =
  | { ok: true; token: string; existed: boolean }
  | { ok: false; reason: "already_claimed" | "db_unavailable" };

/**
 * Attempt to claim a user identity for this browser.
 *
 *   - If no row exists for the user: generate a fresh token, INSERT, and
 *     return ok with `existed=false` so the caller sets the new cookie.
 *   - If a row exists and the request's cookie token matches: returning
 *     visitor, return ok with `existed=true` and the same token.
 *   - Otherwise the slot belongs to someone else: return already_claimed.
 *
 * Implementation note: we use a single UPSERT with a WHERE to atomically
 * skip when someone else already owns the row.
 */
export async function tryClaim(
  userName: string,
  presentedToken: string | null,
): Promise<ClaimOutcome> {
  if (!isDbEnabled()) return { ok: false, reason: "db_unavailable" };
  const pool = getPool();
  try {
    // 1. Check if there's already a row.
    const existing = await pool.query(
      `SELECT claim_token FROM admin_claims WHERE user_name = $1`,
      [userName],
    );
    if (existing.rowCount && existing.rows[0]) {
      const dbToken = existing.rows[0].claim_token;
      if (presentedToken && presentedToken === dbToken) {
        return { ok: true, token: dbToken, existed: true };
      }
      return { ok: false, reason: "already_claimed" };
    }
    // 2. No row yet — insert atomically. ON CONFLICT DO NOTHING handles
    //    the race where two requests arrive simultaneously; whichever
    //    INSERT wins, we re-read and either accept the winner's token (if
    //    it matches our generated one) or fail with already_claimed.
    const fresh = randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO admin_claims (user_name, claim_token)
       VALUES ($1, $2)
       ON CONFLICT (user_name) DO NOTHING`,
      [userName, fresh],
    );
    const after = await pool.query(
      `SELECT claim_token FROM admin_claims WHERE user_name = $1`,
      [userName],
    );
    const winnerToken = after.rows[0]?.claim_token;
    if (winnerToken === fresh) {
      return { ok: true, token: fresh, existed: false };
    }
    // Someone else won the race. Treat as already_claimed.
    return { ok: false, reason: "already_claimed" };
  } catch (e) {
    console.warn("[claims] tryClaim failed:", e);
    return { ok: false, reason: "db_unavailable" };
  }
}

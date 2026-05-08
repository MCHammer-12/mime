/**
 * Token + identity helpers shared across the Vercel assist endpoints.
 *
 * Auth model: a shared `ASSIST_TOKEN` env var is the credential. The
 * client appends `?t=<token>` to every request; we constant-time-compare
 * to the env var. No cookies, no per-user identity beyond the `?as=`
 * query param.
 *
 * This is "secrecy-as-credential" by design — same pattern as the Replit
 * admin URL token. Fine for an internal note-taking tool against an
 * already-private DB, not fine for anything public.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

function pickQuery(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Constant-time string compare so a malicious caller can't binary-search
 * the token via response timing. Same length-prefix trick crypto.timingSafeEqual
 * uses; we don't import crypto to keep the cold-start lean.
 */
function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Returns true if the request carries a valid token; otherwise writes
 *  a 401 and returns false so the handler can early-return. */
export function requireToken(
  req: VercelRequest,
  res: VercelResponse,
): boolean {
  const expected = process.env.ASSIST_TOKEN ?? "";
  if (!expected) {
    // No token configured = deployment misconfigured. Fail closed.
    res.status(500).json({ error: "ASSIST_TOKEN not configured" });
    return false;
  }
  const got = pickQuery(req.query.t) ?? "";
  if (!constantTimeEq(got, expected)) {
    res.status(401).json({ error: "invalid or missing token" });
    return false;
  }
  return true;
}

/** Read the `?as=<name>` identity. Trimmed, capped at 60 chars, null
 *  if absent. The client uses this for note attribution + per-assistant
 *  state (done flags, completion stats). */
export function readAs(req: VercelRequest): string | null {
  const raw = pickQuery(req.query.as);
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 60);
}

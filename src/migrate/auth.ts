/**
 * Admin auth — obscure-URL-token + cookie session.
 *
 * Architecture:
 *   - Public-facing assist UI lives at `/`.
 *   - Admin UI ("Toby 2.0") lives at `/<ADMIN_URL_TOKEN>/`. Visiting that
 *     URL sets an HttpOnly cookie carrying the token; the client UI then
 *     calls admin API endpoints (`/api/jobs/*`, etc.) which check the
 *     cookie via `requireAdmin`.
 *   - Token rotation: change `ADMIN_URL_TOKEN` env var → existing cookies
 *     are rejected on next request → admin must re-load from new URL.
 *   - Local dev: if `ADMIN_URL_TOKEN` is unset, every request is treated
 *     as admin so the existing `npx tsx src/migrate/server.ts` flow keeps
 *     working without ceremony.
 *
 * NOT for general-purpose auth: there is no per-user identity, no audit,
 * no IP binding. The token in the URL path appears in browser history,
 * server access logs, and referer headers — that's acceptable here only
 * because the deployment itself is private (Replit invite-list gated).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

const ADMIN_URL_TOKEN = process.env.ADMIN_URL_TOKEN ?? "";
const ADMIN_AUTH_ENABLED = ADMIN_URL_TOKEN !== "";
const COOKIE_NAME = "admin_token";

export function isAdminAuthEnabled(): boolean {
  return ADMIN_AUTH_ENABLED;
}

/**
 * Admin entry path with leading slash. In prod, the configured token
 * (e.g. "/abc123"). In dev (no token set), "/admin" — a stable URL so
 * local development still reaches the dashboard.
 */
export function adminPathPrefix(): string {
  return ADMIN_AUTH_ENABLED ? `/${ADMIN_URL_TOKEN}` : "/admin";
}

/** True if the URL is the admin entry (with or without trailing slash / index.html). */
export function isAdminEntryUrl(url: string): boolean {
  const prefix = adminPathPrefix();
  const path = url.split("?")[0];
  return (
    path === prefix ||
    path === prefix + "/" ||
    path === prefix + "/index.html"
  );
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie ?? "";
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** True when the request carries a valid admin cookie (or auth is disabled). */
export function isAdmin(req: IncomingMessage): boolean {
  if (!ADMIN_AUTH_ENABLED) return true;
  return parseCookies(req)[COOKIE_NAME] === ADMIN_URL_TOKEN;
}

/** Set the admin cookie. 1-year expiry; rotation invalidates immediately. */
export function setAdminCookie(res: ServerResponse): void {
  if (!ADMIN_AUTH_ENABLED) return;
  const maxAge = 60 * 60 * 24 * 365;
  res.setHeader(
    "set-cookie",
    `${COOKIE_NAME}=${ADMIN_URL_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
  );
}

/**
 * Gate an admin endpoint. Returns true if allowed (and the caller should
 * proceed); false (and writes 401) if not.
 */
export function requireAdmin(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (isAdmin(req)) return true;
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "admin auth required" }));
  return false;
}

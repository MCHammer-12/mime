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
const USER_COOKIE_NAME = "admin_user";

/** Allowed admin identities. Anything else is rejected. Loose validation
 *  is intentional — adding a new admin means editing this list. */
const ALLOWED_ADMIN_USERS = ["Austin", "Michael"];
export function isAllowedAdminUser(name: string): boolean {
  return ALLOWED_ADMIN_USERS.includes(name);
}

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
 * Read the picked admin identity (Austin / Michael) from the request
 * cookie. Returns null until the operator picks one via the first-visit
 * modal. Validation rejects anything outside ALLOWED_ADMIN_USERS so a
 * stale cookie can't smuggle in a bogus value.
 */
export function getAdminUser(req: IncomingMessage): string | null {
  const raw = parseCookies(req)[USER_COOKIE_NAME];
  if (!raw) return null;
  const decoded = decodeURIComponent(raw);
  return isAllowedAdminUser(decoded) ? decoded : null;
}

/**
 * Set the admin-user cookie. Readable by client JS so the UI can surface
 * the current identity in the header without a round-trip — that's
 * intentional, the value isn't a secret (it's just "Austin" / "Michael").
 */
export function setAdminUserCookie(res: ServerResponse, user: string): void {
  if (!isAllowedAdminUser(user)) return;
  const maxAge = 60 * 60 * 24 * 365;
  res.setHeader(
    "set-cookie",
    `${USER_COOKIE_NAME}=${encodeURIComponent(user)}; Path=/; SameSite=Lax; Max-Age=${maxAge}`,
  );
}

export function clearAdminUserCookie(res: ServerResponse): void {
  res.setHeader(
    "set-cookie",
    `${USER_COOKIE_NAME}=; Path=/; SameSite=Lax; Max-Age=0`,
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

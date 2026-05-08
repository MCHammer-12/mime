/**
 * Neon serverless driver wrapper. Each function gets its own `sql`
 * tagged-template instance — Neon's HTTP driver handles connection
 * pooling for us, so this is cheap to instantiate per request.
 *
 * Caller passes raw SQL via the tagged template; the driver auto-binds
 * params and prevents injection.
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let cachedSql: NeonQueryFunction<false, false> | null = null;

export function sql(): NeonQueryFunction<false, false> {
  if (cachedSql) return cachedSql;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not configured");
  cachedSql = neon(url);
  return cachedSql;
}

/**
 * Coerce a value from `jobs.notes[itemId]` into the structured shape the
 * assist UI expects. Lifted from src/migrate/jobs.ts so the Vercel side
 * stays self-contained.
 *
 * Legacy entries are bare strings (admin notes written before the
 * structured shape shipped); newer entries are { text, author?, savedAt }.
 */
export interface CoercedNote {
  text: string;
  author: string | null;
  savedAt: string | null;
}

export function coerceNote(value: unknown): CoercedNote | null {
  if (typeof value === "string") {
    return value.length > 0 ? { text: value, author: null, savedAt: null } : null;
  }
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.text === "string" && v.text.length > 0) {
      return {
        text: v.text,
        author: typeof v.author === "string" ? v.author : null,
        savedAt: typeof v.savedAt === "string" ? v.savedAt : null,
      };
    }
  }
  return null;
}

/** Best-effort JSON body reader. Vercel parses JSON automatically when
 *  Content-Type is application/json, but we handle string fallback. */
export function readJsonBody(body: unknown): Record<string, any> {
  if (!body) return {};
  if (typeof body === "string") {
    try { return JSON.parse(body); } catch { return {}; }
  }
  if (typeof body === "object") return body as Record<string, any>;
  return {};
}

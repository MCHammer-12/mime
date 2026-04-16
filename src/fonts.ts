/**
 * Font provisioning pipeline (Package E3).
 *
 * Collects custom font families referenced across all block types in a
 * parsed email template, resolves each against the Google Fonts CSS2
 * API to obtain downloadable WOFF2 URLs, and packages the result as a
 * FontPlan embedded in the exported template.
 *
 * The importer (`redo/manage/src/import-klaviyo-templates.ts`) consumes
 * the plan: resolved fonts are auto-uploaded + registered in the target
 * team's brand kit; unresolved fonts block the import with a clear
 * per-font error so the merchant can add them in the Redo UI first.
 */
import type { Section } from "./renderer/types.js";

// ─── Web-safe allowlist (kept in sync with parser/blocks/text.ts) ─
const WEB_SAFE_FONTS = new Set([
  "arial",
  "courier new",
  "georgia",
  "lucida sans unicode",
  "lucida grande",
  "tahoma",
  "times new roman",
  "times",
  "trebuchet ms",
  "verdana",
  "geneva",
  "courier",
  "palatino",
  "garamond",
  "bookman",
  "comic sans ms",
  "impact",
  "helvetica",
  "helvetica neue",
  "sans-serif",
  "serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
]);

function isCustomFont(family: string): boolean {
  return !WEB_SAFE_FONTS.has(family.trim().toLowerCase());
}

// ─── Inline HTML font extraction (TextBlock inner spans) ─────────
const FONT_FAMILY_RE = /font-family:\s*([^;}"]+)/gi;

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&apos;/g, "'");
}

function parseFontList(raw: string): string[] {
  return raw
    .split(",")
    .map((f) => f.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function extractFontsFromHtml(html: string): string[] {
  const decoded = decodeHtmlEntities(html);
  const out: string[] = [];
  let m: RegExpExecArray | null;
  FONT_FAMILY_RE.lastIndex = 0;
  while ((m = FONT_FAMILY_RE.exec(decoded)) !== null) {
    for (const f of parseFontList(m[1]!)) {
      if (isCustomFont(f)) out.push(f);
    }
  }
  return out;
}

// ─── Collection across all block types ──────────────────────────

export interface FontUsage {
  family: string;
  /** Sorted list of usage sites (e.g. ["button", "text", "text.inline"]) */
  usedBy: string[];
}

/**
 * Walk Section[] and return a deduped list of custom font families
 * referenced anywhere — block-level fontFamily fields plus inline
 * font-family styles inside TextBlock HTML plus nested InlineButton
 * fontFamily inside ProductsBlock (checkoutButton + lineItemButtons).
 */
export function collectFonts(sections: Section[]): FontUsage[] {
  const map = new Map<string, Set<string>>();
  const add = (family: string | undefined, where: string): void => {
    if (!family || !isCustomFont(family)) return;
    const key = family.trim();
    const set = map.get(key) ?? new Set<string>();
    set.add(where);
    map.set(key, set);
  };

  const walk = (block: unknown, prefix = ""): void => {
    if (!block || typeof block !== "object") return;
    const b = block as Record<string, unknown>;
    const t = typeof b.type === "string" ? (b.type as string) : "";
    const where = prefix + t;

    if (typeof b.fontFamily === "string") add(b.fontFamily, where);

    if (t === "text" && typeof b.text === "string") {
      for (const f of extractFontsFromHtml(b.text)) add(f, where + ".inline");
    }

    if (t === "interactive-cart") {
      const cb = b.checkoutButton as Record<string, unknown> | undefined;
      const lb = b.lineItemButtons as Record<string, unknown> | undefined;
      if (cb && typeof cb.fontFamily === "string")
        add(cb.fontFamily, where + ".checkoutButton");
      if (lb && typeof lb.fontFamily === "string")
        add(lb.fontFamily, where + ".lineItemButtons");
    }

    if (t === "column" && Array.isArray(b.columns)) {
      for (const col of b.columns) walk(col, prefix + "column.");
    }
  };

  for (const s of sections) walk(s);

  return [...map.entries()]
    .map(([family, usedBy]) => ({ family, usedBy: [...usedBy].sort() }))
    .sort((a, b) => a.family.localeCompare(b.family));
}

// ─── Google Fonts CSS2 resolver ─────────────────────────────────

// Weight axes we request. Covers what Klaviyo templates actually use
// (regular + bold + italics of each). Google Fonts returns only the
// weights that exist for the family — others are silently dropped.
const REQUEST_WEIGHTS = [400, 700];

export interface FontFileSpec {
  weight: number;
  italic: boolean;
  /** WOFF2 URL on fonts.gstatic.com. Latin subset is the first seen. */
  url: string;
}

export type GoogleFontResolved =
  | {
      family: string;
      available: true;
      files: FontFileSpec[];
      cssUrl: string;
    }
  | {
      family: string;
      available: false;
      reason: string;
    };

/**
 * Title-case a family: every word gets initial-cap + rest lowercased.
 * Used as a casing-fallback — Google's CSS endpoint is case-sensitive,
 * so "OSWALD" 400s but "Oswald" works. Applied only when the literal
 * spelling fails, so mixed-case brand names like "PT Sans" survive.
 */
function titleCaseFamily(family: string): string {
  return family
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

async function probeGoogleFonts(
  familyForUrl: string,
): Promise<
  | { ok: true; files: FontFileSpec[]; cssUrl: string }
  | { ok: false; reason: string }
> {
  const axes = REQUEST_WEIGHTS.flatMap((w) => [`0,${w}`, `1,${w}`]).join(";");
  const cssUrl = `https://fonts.googleapis.com/css2?family=${familyForUrl}:ital,wght@${axes}&display=swap`;
  let res: Response;
  try {
    res = await fetch(cssUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `network error: ${msg}` };
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
  const files = parseGoogleFontsCss(await res.text());
  if (files.length === 0) return { ok: false, reason: "no WOFF2 URLs" };
  return { ok: true, files, cssUrl };
}

/**
 * Probe the Google Fonts CSS2 API for a family. Returns available+files
 * when the family exists, otherwise available:false with a reason.
 *
 * Tries the literal family first (preserves brand casing like "PT Sans").
 * Falls back to title-case ("OSWALD" → "Oswald") if the literal 400s.
 *
 * Uses the public CSS endpoint (no API key). A modern UA header is
 * required to receive WOFF2 URLs — older UAs get TTF/WOFF.
 */
export async function resolveGoogleFont(
  family: string,
): Promise<GoogleFontResolved> {
  const literal = family.trim().replace(/\s+/g, "+");
  const first = await probeGoogleFonts(literal);
  if (first.ok) {
    return { family, available: true, files: first.files, cssUrl: first.cssUrl };
  }

  const titled = titleCaseFamily(family).replace(/\s+/g, "+");
  if (titled !== literal) {
    const second = await probeGoogleFonts(titled);
    if (second.ok) {
      return { family, available: true, files: second.files, cssUrl: second.cssUrl };
    }
  }

  return { family, available: false, reason: first.reason };
}

const FONT_FACE_BLOCK_RE = /@font-face\s*\{([^}]+)\}/g;

function parseGoogleFontsCss(css: string): FontFileSpec[] {
  // Dedupe by (weight, italic): Google returns multiple @font-face per
  // unicode-range subset; we only need one WOFF2 per style (first seen,
  // which is the latin subset). Brand kit stores one file per style.
  const seen = new Set<string>();
  const out: FontFileSpec[] = [];
  let m: RegExpExecArray | null;
  FONT_FACE_BLOCK_RE.lastIndex = 0;
  while ((m = FONT_FACE_BLOCK_RE.exec(css)) !== null) {
    const block = m[1]!;
    const styleMatch = block.match(/font-style:\s*(italic|normal)/i);
    const weightMatch = block.match(/font-weight:\s*(\d+)/);
    const urlMatch = block.match(
      /src:\s*url\(([^)]+)\)\s*format\(['"]?woff2['"]?\)/i,
    );
    if (!urlMatch) continue;
    const weight = weightMatch ? parseInt(weightMatch[1]!, 10) : 400;
    const italic = styleMatch?.[1]?.toLowerCase() === "italic";
    const key = `${weight}-${italic}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      weight,
      italic,
      url: urlMatch[1]!.replace(/^['"]|['"]$/g, ""),
    });
  }
  return out;
}

// ─── Plan assembly ──────────────────────────────────────────────

export interface FontPlanEntry {
  family: string;
  usedBy: string[];
  resolution: GoogleFontResolved;
}

export interface FontPlan {
  entries: FontPlanEntry[];
  /** True if any required font is not on Google Fonts — importer must block. */
  hasUnresolved: boolean;
}

/**
 * End-to-end: collect custom fonts from the sections, resolve each
 * against Google Fonts concurrently, and return the aggregated plan.
 *
 * If there are no custom fonts, returns an empty plan (hasUnresolved: false).
 */
export async function buildFontPlan(sections: Section[]): Promise<FontPlan> {
  const usages = collectFonts(sections);
  if (usages.length === 0) return { entries: [], hasUnresolved: false };

  const resolutions = await Promise.all(
    usages.map((u) => resolveGoogleFont(u.family)),
  );
  const entries = usages.map((u, i) => ({
    family: u.family,
    usedBy: u.usedBy,
    resolution: resolutions[i]!,
  }));
  return {
    entries,
    hasUnresolved: entries.some((e) => !e.resolution.available),
  };
}

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
    if (!family) return;
    // Normalize CamelCase → spaced (CenturyGothic → Century Gothic) so
    // duplicate spellings of the same family collapse to one entry.
    // Strip weight suffix before Google Fonts lookup (base family only).
    const base = stripWeightSuffix(normalizeFontFamilyName(family));
    if (!isCustomFont(base)) return;
    const set = map.get(base) ?? new Set<string>();
    set.add(where);
    map.set(base, set);
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

// Weight axes we request. Per Redo brand-kit convention, each weight is
// imported as its OWN CustomFontFamily (e.g. "Poppins SemiBold" = distinct
// from "Poppins") rather than as multiple styles under one family. This
// lets Quill switch between weights via the font-family dropdown (Quill's
// own `bold` blot is binary and can't represent semibold/light/etc.).
//
// Skip Bold (700) and ExtraBold (800) per Redo convention — those weights
// would collide with Quill's built-in bold toggle. Text in a Klaviyo
// source that used 700/800 gets snapped to the closest available variant
// at parse time (see weightToFamilySuffix).
const REQUEST_WEIGHTS = [100, 300, 400, 500, 600, 900];

/**
 * Redo brand-kit convention: one CustomFontFamily per weight, suffixed
 * with the weight name. Maps a numeric weight to the suffix used in the
 * family name. Weight 400 has no suffix (base family).
 *
 * Bold (700) and ExtraBold (800) are explicitly NOT imported — those
 * would conflict with Quill's binary bold. Source spans using those
 * weights get snapped to the closest available variant.
 */
export function weightToFamilySuffix(weight: number): string {
  if (weight <= 200) return "Thin";
  if (weight <= 300) return "Light";
  if (weight === 400) return ""; // base
  if (weight === 500) return "Medium";
  if (weight === 600) return "SemiBold";
  if (weight === 700) return "SemiBold"; // fallback — Bold not imported
  if (weight === 800) return "Black"; // fallback — ExtraBold not imported
  return "Black"; // 900+
}

/** Weights we actually register in the brand kit (skip 700, 800). */
export function isImportedWeight(weight: number): boolean {
  return weight !== 700 && weight !== 800;
}

/** Build the weighted family name: e.g. "Poppins" + 600 → "Poppins SemiBold". */
export function weightedFamilyName(family: string, weight: number): string {
  const suffix = weightToFamilySuffix(weight);
  return suffix ? `${family} ${suffix}` : family;
}

/**
 * Strip any trailing weight suffix ("SemiBold", "Medium", etc.) from a family
 * name. Used when the block-level fontFamily is a weighted name like
 * "Poppins SemiBold" but Google Fonts only knows the base family "Poppins".
 */
const WEIGHT_SUFFIXES = [
  "Thin",
  "Light",
  "Medium",
  "SemiBold",
  "Bold",
  "ExtraBold",
  "Black",
];
export function stripWeightSuffix(family: string): string {
  for (const suffix of WEIGHT_SUFFIXES) {
    const re = new RegExp(`\\s+${suffix}$`, "i");
    if (re.test(family)) return family.replace(re, "");
  }
  return family;
}

/**
 * Klaviyo source templates routinely contain inline font stacks where
 * the same family appears in two spellings, e.g.
 *   "brandon-grotesque, 'Century Gothic', CenturyGothic, AppleGothic"
 * The CamelCase variant is how CSS normally names PostScript fonts; the
 * spaced version is how Google Fonts indexes them. Without normalization
 * we emit "CenturyGothic" as a distinct family that Google Fonts can't
 * resolve, skip it at upload time, and lose the brand font. Normalize
 * CamelCase into spaced form so both spellings collapse to one family.
 *
 * Split on lowercase→uppercase boundaries, preserving already-spaced
 * names ("Century Gothic" stays as-is).
 */
export function normalizeFontFamilyName(family: string): string {
  const trimmed = family.trim().replace(/^['"]|['"]$/g, "");
  // If the name already contains a space or a hyphen, assume it's
  // properly-formatted (e.g. "Century Gothic", "brandon-grotesque").
  if (/\s|-/.test(trimmed)) return trimmed;
  // Split CamelCase into words: "CenturyGothic" → "Century Gothic",
  // "OpenSans" → "Open Sans", "DMSans" → "DM Sans".
  // Handle sequences of capitals followed by lowercase (DMSans → DM Sans)
  // and lowercase followed by uppercase (CenturyG → Century G).
  return trimmed
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

/**
 * Map of system-only fonts to a Redo-allowed web-safe substitute.
 * Klaviyo's font picker offers Apple/Linotype system fonts (New York,
 * Baskerville) that aren't on Google Fonts and can't be auto-uploaded.
 * Klaviyo templates reference them as either the primary font or in
 * fallback chains — but the originals only render on Apple devices,
 * leaving the email looking inconsistent across Gmail / Outlook.
 *
 * Substituting to a Redo system font (web-safe, no brand-kit upload)
 * makes the email render consistently everywhere. Georgia is the
 * screen-optimized closest match of Redo's allowed system serifs.
 *
 * Keys are normalized (post-CamelCase-split, post-quote-strip).
 */
const SYSTEM_FONT_SUBSTITUTIONS: Record<string, string> = {
  baskerville: "Georgia",
  "new york": "Georgia",
};

/** Look up a font family in SYSTEM_FONT_SUBSTITUTIONS, returning original if no match. */
export function substituteSystemFont(family: string): string {
  const key = normalizeFontFamilyName(family).toLowerCase();
  return SYSTEM_FONT_SUBSTITUTIONS[key] ?? family;
}

/**
 * Rewrite every `font-family:` declaration in HTML, swapping system-only
 * fonts (New York, Baskerville) for their web-safe substitutes. Operates
 * on raw HTML so inline `<span style="font-family: 'New York', ...">` ends
 * up with `font-family: 'Georgia', ...` before any other parsing runs.
 *
 * Substitutes the primary AND any fallback occurrences (so the system
 * font name doesn't survive in the chain at all). Quoting is normalized
 * to single quotes around any name with whitespace.
 */
export function substituteSystemFontsInHtml(html: string): string {
  const FONT_FAMILY_DECL_RE = /font-family:\s*([^;}"]+)/gi;
  return html.replace(FONT_FAMILY_DECL_RE, (full, families: string) => {
    const list = families.split(",").map((f) => f.trim());
    let changed = false;
    const seen = new Set<string>();
    const newList: string[] = [];
    for (const raw of list) {
      const stripped = raw.replace(/^['"]|['"]$/g, "");
      const key = normalizeFontFamilyName(stripped).toLowerCase();
      const sub = SYSTEM_FONT_SUBSTITUTIONS[key];
      if (sub) {
        changed = true;
        if (seen.has(sub.toLowerCase())) continue;
        seen.add(sub.toLowerCase());
        newList.push(/\s/.test(sub) ? `'${sub}'` : sub);
      } else {
        if (seen.has(stripped.toLowerCase())) continue;
        seen.add(stripped.toLowerCase());
        newList.push(raw);
      }
    }
    if (!changed) return full;
    return `font-family: ${newList.join(", ")}`;
  });
}

// ─── Fallback font resolver ──────────────────────────────────────
//
// Custom fonts don't render in most email apps (only Apple Mail); the
// brand-kit @font-face is a progressive-enhancement layer. Everywhere
// else the fallback renders. For readability across Gmail / Outlook /
// webmail we want the fallback to visually approximate the real brand
// font — same serif/sans category, similar x-height, similar widths.
//
// Redo's allowed fallback list (from `FontFamily` enum):
//   Arial · Courier New · Georgia · Lucida Sans Unicode · Tahoma ·
//   Times New Roman · Trebuchet MS · Verdana
//
// Mapping below covers the Google Fonts that Klaviyo-authored templates
// actually use. Unknown families fall through to the heuristic below.

export type AllowedFallback =
  | "Arial"
  | "Courier New"
  | "Georgia"
  | "Lucida Sans Unicode"
  | "Tahoma"
  | "Times New Roman"
  | "Trebuchet MS"
  | "Verdana";

const FALLBACK_MAP: Record<string, AllowedFallback> = {
  // Geometric / rounded sans-serifs → Verdana (wide, rounded, readable)
  poppins: "Verdana",
  nunito: "Verdana",
  "nunito sans": "Verdana",
  "open sans": "Verdana",
  ubuntu: "Verdana",
  lato: "Verdana",
  "pt sans": "Verdana",

  // Neutral / geometric sans-serifs → Arial (closest default)
  inter: "Arial",
  roboto: "Arial",
  montserrat: "Arial",
  raleway: "Arial",
  kanit: "Arial",
  "work sans": "Arial",
  "league spartan": "Arial",
  oswald: "Arial",
  "dm sans": "Arial",
  "source sans pro": "Arial",
  "source sans 3": "Arial",
  barlow: "Arial",
  mulish: "Arial",
  rubik: "Arial",
  karla: "Arial",
  "libre franklin": "Arial",
  archivo: "Arial",
  manrope: "Arial",
  "bebas neue": "Arial",
  "archivo black": "Arial",

  // Humanist / tall-x-height sans → Tahoma
  "space grotesk": "Tahoma",
  "fira sans": "Tahoma",
  "helvetica neue": "Arial",

  // Friendly display sans → Trebuchet MS
  quicksand: "Trebuchet MS",
  comfortaa: "Trebuchet MS",

  // Serifs → Georgia (screen-optimized serif)
  "playfair display": "Georgia",
  merriweather: "Georgia",
  lora: "Georgia",
  "source serif pro": "Georgia",
  "eb garamond": "Georgia",
  "cormorant garamond": "Georgia",
  cormorant: "Georgia",
  "crimson text": "Georgia",
  "libre caslon text": "Georgia",
  "abril fatface": "Georgia",

  // Traditional serifs → Times New Roman
  "pt serif": "Times New Roman",
  "noto serif": "Times New Roman",

  // Monospace → Courier New
  "jetbrains mono": "Courier New",
  "ibm plex mono": "Courier New",
  "source code pro": "Courier New",
  "fira code": "Courier New",
  "roboto mono": "Courier New",
  "space mono": "Courier New",
};

/**
 * Pick the best Redo-allowed fallback for a given custom font family.
 * Uses an explicit mapping for common Google Fonts, falling back to a
 * keyword heuristic on the family name.
 */
export function resolveFallbackFont(family: string): AllowedFallback {
  const lower = stripWeightSuffix(family).trim().toLowerCase();
  if (FALLBACK_MAP[lower]) return FALLBACK_MAP[lower]!;

  // Keyword heuristics for unknown families.
  if (
    /\b(serif|text|roman|caslon|garamond|playfair|lora|merriweather)\b/i.test(
      lower,
    )
  ) {
    return "Georgia";
  }
  if (/\b(mono|code|typewriter|courier)\b/i.test(lower)) {
    return "Courier New";
  }
  // Default: generic sans-serif.
  return "Arial";
}

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
  /**
   * Web-safe Redo-allowed fallback to apply in the brand-kit's
   * CustomFontFamily.fallbackFont. Visually closest match to the real font.
   */
  fallback: AllowedFallback;
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
    fallback: resolveFallbackFont(u.family),
  }));
  return {
    entries,
    hasUnresolved: entries.some((e) => !e.resolution.available),
  };
}

/**
 * Utilities for parsing inline CSS styles from Klaviyo HTML elements.
 */

import { Padding } from "../renderer/types.js";
import { substituteSystemFont } from "../fonts.js";

export function parseInlineStyles(
  style: string | undefined,
): Record<string, string> {
  if (!style) return {};
  const result: Record<string, string> = {};
  for (const part of style.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const key = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

export function parsePadding(style: Record<string, string>): Padding {
  let top = 0,
    right = 0,
    bottom = 0,
    left = 0;

  if (style["padding"]) {
    const parts = style["padding"]
      .replace(/px/g, "")
      .trim()
      .split(/\s+/)
      .map(Number);
    if (parts.length === 1) {
      top = right = bottom = left = parts[0]!;
    } else if (parts.length === 2) {
      top = bottom = parts[0]!;
      right = left = parts[1]!;
    } else if (parts.length === 3) {
      top = parts[0]!;
      right = left = parts[1]!;
      bottom = parts[2]!;
    } else {
      top = parts[0]!;
      right = parts[1]!;
      bottom = parts[2]!;
      left = parts[3]!;
    }
  }

  const pt = parsePx(style["padding-top"]);
  const pr = parsePx(style["padding-right"]);
  const pb = parsePx(style["padding-bottom"]);
  const pl = parsePx(style["padding-left"]);
  if (pt !== undefined) top = pt;
  if (pr !== undefined) right = pr;
  if (pb !== undefined) bottom = pb;
  if (pl !== undefined) left = pl;

  return { top, right, bottom, left };
}

export function parsePx(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const num = parseFloat(value);
  return isNaN(num) ? undefined : num;
}

export function parseColor(value: string | undefined): string {
  if (!value) return "#000000";
  return value.trim();
}

export function parseFontFamily(value: string | undefined): string {
  if (!value) return "Arial";
  const primary = value.replace(/['"]/g, "").split(",")[0].trim();
  return substituteSystemFont(primary);
}

export function parseFontSize(value: string | undefined): number {
  return parsePx(value) ?? 14;
}

export function parseBorderTop(
  style: string | undefined,
): { width: number; color: string } | null {
  if (!style) return null;
  const styles = parseInlineStyles(style);
  const bt = styles["border-top"];
  if (!bt) return null;
  // "solid 4px #3d3935"
  const match = bt.match(
    /(?:solid|dashed|dotted)?\s*(\d+(?:\.\d+)?)\s*px\s*(#[0-9a-fA-F]{3,8}|\w+)/,
  );
  if (!match) return null;
  return { width: parseFloat(match[1]), color: match[2] };
}

const SOCIAL_PATTERNS: [RegExp, string][] = [
  [/facebook\.com/i, "facebook"],
  [/instagram\.com/i, "instagram"],
  [/twitter\.com/i, "twitter"],
  [/x\.com/i, "x"],
  [/youtube\.com/i, "youtube"],
  [/tiktok\.com/i, "tiktok"],
  [/linkedin\.com/i, "linkedin"],
  [/pinterest\.com/i, "pinterest"],
  [/snapchat\.com/i, "snapchat"],
  [/whatsapp\.com/i, "whatsapp"],
  [/telegram\.(me|org)/i, "telegram"],
  [/discord\.(gg|com)/i, "discord"],
  [/twitch\.tv/i, "twitch"],
  [/reddit\.com/i, "reddit"],
  [/threads\.net/i, "threads"],
  [/bsky\.app/i, "bluesky"],
];

export function detectSocialPlatform(url: string): string | null {
  for (const [pattern, platform] of SOCIAL_PATTERNS) {
    if (pattern.test(url)) return platform;
  }
  return null;
}

/**
 * Walk up from a block's content element through ALL ancestors looking for
 * `background-color` / `background`. Klaviyo sometimes puts the section
 * background on the OUTER wrapper td (e.g. footer `#f2f2f2`) while the
 * inner content td has no background — but it also commonly puts the
 * section/email-level bg on a wrapping <div> or <table> (e.g. dark-mode
 * email templates with a body-level black wrapper). Walking only tds
 * misses those, so we walk every parent element until we find a bg color
 * or hit the document root. `transparent` is ignored — it's an explicit
 * "no background here" marker, keep walking.
 */
export function findAncestorBackgroundColor(
  $el: cheerio.Cheerio<any>,
): string | null {
  let current = $el;
  let guard = 0;
  while (current.length > 0 && guard++ < 50) {
    const style = parseInlineStyles(current.attr("style"));
    const bgColor = style["background-color"];
    const bgShorthand = style["background"];
    const raw = bgColor || bgShorthand;
    if (raw) {
      // When the value is the `background` shorthand (e.g.
      // "#222222 url(...) center center / auto repeat"), keep just
      // the color token. Redo's email-template Mongoose schema stores
      // sectionColor as a plain String and downstream renderers
      // expect a CSS color — passing the full shorthand silently
      // corrupts the saved template and tripped 500s on
      // createSavedEmailTemplate (SHOC bundle 2026-06-08).
      const color = extractCssColor(raw);
      if (color && color !== "transparent") return color;
    }
    const parent = current.parent();
    if (parent.length === 0 || parent[0] === current[0]) break;
    current = parent;
  }
  return null;
}

/** Extract just the color token from a CSS value that might be a full
 *  `background` shorthand. Matches hex (#fff / #ffffff / #ffffffaa),
 *  rgb/rgba/hsl/hsla functional values, and named colors. Returns null
 *  when no color is present (e.g. value is `linear-gradient(...)` or a
 *  pure `url(...)` reference with no color fallback). */
function extractCssColor(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  // Hex first — most specific.
  const hex = v.match(/#[0-9a-fA-F]{3,8}\b/);
  if (hex) return hex[0];
  // Functional color values: rgb(...), rgba(...), hsl(...), hsla(...).
  const fn = v.match(/\b(?:rgba?|hsla?)\s*\([^)]+\)/i);
  if (fn) return fn[0];
  // Strip url(...) tokens before scanning for named colors — they'd
  // otherwise match as "plausible identifiers" since their parens
  // get stripped during normalization.
  const withoutUrls = v.replace(/url\s*\([^)]*\)/gi, "");
  // Named colors. Match the first word that isn't a known non-color
  // CSS keyword (so "repeat", "center", "auto", "no-repeat", etc.
  // don't get picked).
  const NON_COLOR = new Set([
    "center", "left", "right", "top", "bottom", "auto", "cover",
    "contain", "repeat", "no-repeat", "repeat-x", "repeat-y", "round",
    "space", "fixed", "scroll", "local", "border-box", "padding-box",
    "content-box", "inherit", "initial", "unset", "revert",
  ]);
  for (const tok of withoutUrls.split(/\s+/)) {
    const lower = tok.toLowerCase().replace(/[(),]/g, "");
    if (!lower || NON_COLOR.has(lower) || /^\d/.test(lower) || lower === "/") continue;
    return tok;
  }
  return null;
}

/**
 * Sum the padding of a content td and all its td ancestors within the
 * same `component-wrapper`. Klaviyo routinely nests tds where the outer
 * wrapper td carries the section's horizontal padding (e.g. `padding:0
 * 18px`) while the inner `kl-text` / `kl-button` / etc. td carries its
 * own vertical padding (or zero). In rendered HTML these paddings STACK;
 * reading only the inner td produces a misaligned block with no margin.
 *
 * Stops at the outer <table> of the component-wrapper (doesn't cross
 * into the MJML column shell) to avoid double-counting Klaviyo's 600px
 * stage layout.
 */
export function sumAncestorPadding(
  $td: cheerio.Cheerio<any>,
): { top: number; right: number; bottom: number; left: number } {
  const total = { top: 0, right: 0, bottom: 0, left: 0 };
  let current = $td;
  let guard = 0;
  while (current.length > 0 && guard++ < 10) {
    const p = parsePadding(parseInlineStyles(current.attr("style")));
    total.top += p.top;
    total.right += p.right;
    total.bottom += p.bottom;
    total.left += p.left;
    // Stop once we've left the component-wrapper (its outer <table> is
    // wrapped in a <div class="component-wrapper">, which has no td parent).
    const parent = current.parent().closest("td");
    if (parent.length === 0 || parent[0] === current[0]) break;
    // Also stop if the parent is OUTSIDE a component-wrapper (we've
    // climbed too far — into the MJML stage).
    if (parent.closest(".component-wrapper, .gxp-component-wrapper").length === 0) {
      break;
    }
    current = parent;
  }
  return total;
}

export function detectSocialIconColor(imgSrc: string): string {
  // Order matters: check longer/more-specific paths before their prefixes.
  // Klaviyo "inverse" icon sets (white-on-dark) must be checked before
  // "/subtle/" / "/solid/" since the inverse paths contain those words.
  if (imgSrc.includes("subtleinverse") || imgSrc.includes("solidinverse")) return "white";
  if (imgSrc.includes("/white/") || imgSrc.includes("/inverse/")) return "white";
  if (imgSrc.includes("/subtle/")) return "gray";
  if (imgSrc.includes("/solid/")) return "black";
  return "original";
}

/**
 * Parse a CSS color value (`#fff`, `#ffffff`, `rgb(0,0,0)`, `rgba(...)`)
 * to relative luminance per WCAG. Returns null when parsing fails so the
 * caller can fall back. Range 0 (black) to 1 (white).
 */
export function relativeLuminance(color: string): number | null {
  const c = color.trim().toLowerCase();
  let r: number, g: number, b: number;

  if (c.startsWith("#")) {
    const hex = c.slice(1);
    if (hex.length === 3) {
      r = parseInt(hex[0]! + hex[0]!, 16);
      g = parseInt(hex[1]! + hex[1]!, 16);
      b = parseInt(hex[2]! + hex[2]!, 16);
    } else if (hex.length === 6 || hex.length === 8) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    } else {
      return null;
    }
  } else if (c.startsWith("rgb")) {
    const m = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!m) return null;
    r = parseInt(m[1]!, 10);
    g = parseInt(m[2]!, 10);
    b = parseInt(m[3]!, 10);
  } else {
    return null;
  }
  if (![r, g, b].every((v) => Number.isFinite(v) && v >= 0 && v <= 255)) return null;

  // sRGB → linear, then weighted sum (Rec. 709 / WCAG)
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Pick black or white as the contrasting fill against `bgColor`. Used to
 * decide social icon / link colors when the source HTML doesn't carry an
 * explicit color and we need a sensible default for a custom-uploaded asset.
 * Threshold matches the WCAG-suggested 0.179 cutoff for a small visual
 * element on a flat background.
 */
export function pickContrastingColor(
  bgColor: string,
  options: { dark: string; light: string } = { dark: "#000000", light: "#ffffff" },
): string {
  const lum = relativeLuminance(bgColor);
  if (lum === null) return options.dark;
  return lum < 0.5 ? options.light : options.dark;
}

/**
 * WCAG contrast ratio between two colors. Returns null if either color
 * fails to parse (caller treats unknown contrast as "fine" and skips).
 * Range 1 (no contrast) to 21 (max). Values below 3 are universally
 * unreadable; AA requires 4.5 for normal text.
 */
export function contrastRatio(fg: string, bg: string): number | null {
  const fLum = relativeLuminance(fg);
  const bLum = relativeLuminance(bg);
  if (fLum === null || bLum === null) return null;
  const lighter = Math.max(fLum, bLum);
  const darker = Math.min(fLum, bLum);
  return (lighter + 0.05) / (darker + 0.05);
}

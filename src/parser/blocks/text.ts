import type { TextBlock } from "../../renderer/types.js";
import { EmailBlockType } from "../../renderer/types.js";
import {
  parseColor,
  parseFontFamily,
  parseFontSize,
  parseInlineStyles,
  parsePadding,
} from "../style-utils.js";
import { type $, type El, nextId } from "../helpers.js";
import type { ParseContext } from "../index.js";
import type * as cheerio from "cheerio";

const BLOCK_ELEMENT_RE = /<(h[1-6]|div|table|ul|ol|blockquote|hr|pre)[\s>]/i;

/**
 * Wrap plain text in <p> tags. Block-level elements (h1-h6, table, etc.)
 * and HTML that already contains <p> tags are returned as-is.
 *
 * Alignment used to be written into the HTML here; now it's emitted as
 * TextBlock.textAlign and consumed by the renderer instead.
 */
function wrapText(html: string): string {
  if (html.includes("<p")) return html;
  if (BLOCK_ELEMENT_RE.test(html)) return html;
  return `<p>${html}</p>`;
}

/** Strip empty <table> elements that are template noise. */
function stripEmptyTables(html: string): string {
  return html.replace(/<table[^>]*>\s*<\/table>/gi, "").trim();
}

// ─── Font detection ──────────────────────────────────────────────

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

/**
 * Scan HTML content for font-family declarations and return
 * non-web-safe font names that would need @font-face provisioning.
 */
export function extractCustomFonts(html: string): string[] {
  const decoded = decodeHtmlEntities(html);
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = FONT_FAMILY_RE.exec(decoded)) !== null) {
    for (const font of parseFontList(match[1]!)) {
      if (!WEB_SAFE_FONTS.has(font.toLowerCase())) {
        found.add(font);
      }
    }
  }
  return [...found];
}

// ─── Coupon code detection ───────────────────────────────────────

const COUPON_RE = /\{%\s*coupon_code\s*'([^']*)'?\s*%\}/g;
const PERCENT_RE = /(\d+)\s*%\s*(?:discount|off)/i;
const AMOUNT_RE = /\$\s*(\d+(?:\.\d+)?)\s*(?:discount|off)/i;

export interface CouponCodeInfo {
  couponName: string;
  /** Whether the coupon is on its own line (true) or inline in a sentence (false) */
  isStandalone: boolean;
  /** Inferred discount amount from surrounding text, if detectable */
  inferredAmount?: number;
  /** "percentage" or "fixed" — inferred from surrounding text */
  inferredType?: "percentage" | "fixed";
}

/**
 * Detect {% coupon_code 'Name' %} variables in text HTML.
 * Returns info about each coupon found, including whether it can
 * be mechanically removed (standalone) or needs AI rewrite (inline).
 */
export function extractCouponCodes(html: string): CouponCodeInfo[] {
  const results: CouponCodeInfo[] = [];
  const plainText = html.replace(/<[^>]+>/g, " ");
  let match: RegExpExecArray | null;

  // Infer discount amount/type from surrounding text
  const pctMatch = plainText.match(PERCENT_RE);
  const amtMatch = plainText.match(AMOUNT_RE);
  const inferredAmount = pctMatch
    ? Number(pctMatch[1])
    : amtMatch
      ? Number(amtMatch[1])
      : undefined;
  const inferredType: "percentage" | "fixed" | undefined = pctMatch
    ? "percentage"
    : amtMatch
      ? "fixed"
      : undefined;

  // Wider regex that accounts for optional <span> wrapper around the coupon
  const STANDALONE_COUPON_RE =
    /<br\s*\/?>\s*(?:<br\s*\/?>)?\s*(?:<span[^>]*>)?\s*\{%\s*coupon_code\s*'([^']*)'?\s*%\}\s*(?:<\/span>)?\s*(?:<br\s*\/?>)?\s*<br\s*\/?>/gi;
  const standaloneNames = new Set<string>();
  let sMatch: RegExpExecArray | null;
  while ((sMatch = STANDALONE_COUPON_RE.exec(html)) !== null) {
    standaloneNames.add(sMatch[1] || "");
  }

  COUPON_RE.lastIndex = 0;
  while ((match = COUPON_RE.exec(html)) !== null) {
    const name = match[1] || "";
    results.push({
      couponName: name,
      isStandalone: standaloneNames.has(name),
      inferredAmount,
      inferredType,
    });
  }
  return results;
}

/**
 * Remove standalone {% coupon_code %} variables and surrounding <br> tags.
 * Handles both bare coupons and span-wrapped coupons.
 * Only removes coupons that are on their own line — inline coupons are left
 * for AI rewrite. Returns the cleaned HTML.
 */
export function stripStandaloneCoupons(html: string): string {
  return html.replace(
    /(<br\s*\/?>)\s*(?:<br\s*\/?>)?\s*(?:<span[^>]*>)?\s*\{%\s*coupon_code\s*'[^']*'?\s*%\}\s*(?:<\/span>)?\s*(?:<br\s*\/?>)?\s*(<br\s*\/?>)/gi,
    "$1$2",
  );
}

export function parseTextBlock(
  $: $,
  $td: cheerio.Cheerio<El>,
  _ctx: ParseContext,
): TextBlock | null {
  const $div = $td.children("div").first();
  if ($div.length === 0) return null;

  const tdStyle = parseInlineStyles($td.attr("style"));
  const divStyle = parseInlineStyles($div.attr("style"));
  let textHtml = $div.html() ?? "";

  const $firstLink = $div.find("a").first();
  const linkStyle = parseInlineStyles($firstLink.attr("style"));

  textHtml = stripEmptyTables(textHtml);
  textHtml = stripStandaloneCoupons(textHtml);
  textHtml = wrapText(textHtml);

  const textAlign = divStyle["text-align"];
  const lineHeight = divStyle["line-height"];

  // Bake alignment + line-height into <p> tags since Redo's TextBlock schema
  // has no textAlign/lineHeight fields — they'd be stripped on import.
  if (textAlign || lineHeight) {
    const inlineStyle = [
      textAlign ? `text-align:${textAlign}` : "",
      lineHeight ? `line-height:${lineHeight}` : "",
    ].filter(Boolean).join(";");
    textHtml = textHtml.replace(/<p(?=[\s>])/g, `<p style="${inlineStyle}"`);
  }

  return {
    type: EmailBlockType.TEXT,
    blockId: nextId(),
    sectionPadding: parsePadding(tdStyle),
    sectionColor:
      tdStyle["background-color"] || tdStyle["background"] || "#ffffff",
    text: textHtml,
    textColor: parseColor(divStyle["color"]),
    fontSize: parseFontSize(divStyle["font-size"]),
    fontFamily: parseFontFamily(divStyle["font-family"]),
    linkColor: parseColor(linkStyle["color"] || divStyle["color"]),
    ...(textAlign ? { textAlign } : {}),
    ...(lineHeight ? { lineHeight } : {}),
  };
}

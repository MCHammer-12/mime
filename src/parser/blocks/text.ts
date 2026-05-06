import type { TextBlock } from "../../renderer/types.js";
import { EmailBlockType } from "../../renderer/types.js";
import {
  contrastRatio,
  findAncestorBackgroundColor,
  parseColor,
  parseFontFamily,
  parseFontSize,
  parseInlineStyles,
  parsePadding,
  pickContrastingColor,
  sumAncestorPadding,
} from "../style-utils.js";
import { type $, type El, nextId } from "../helpers.js";
import type { ParseContext } from "../index.js";
import { normalizeFontFamilyName, substituteSystemFontsInHtml, weightedFamilyName } from "../../fonts.js";
import type * as cheerio from "cheerio";

const BLOCK_ELEMENT_RE = /<(h[1-6]|div|table|ul|ol|blockquote|hr|pre)[\s>]/i;

/**
 * If `fg` has poor contrast against `bg` (below `floor`, default 3:1 = below
 * WCAG AA Large), swap to whichever of black/white reads better against bg.
 * Otherwise return `fg` unchanged. Used for text + link defaults so dark-mode
 * Klaviyo templates don't import with invisible black-on-black text.
 */
function applyContrastFloor(fg: string, bg: string, floor: number): string {
  const ratio = contrastRatio(fg, bg);
  if (ratio === null || ratio >= floor) return fg;
  return pickContrastingColor(bg, { dark: "#000000", light: "#ffffff" });
}

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

/**
 * Redo's email builder uses Quill with the `quill-magic-url` plugin, which
 * auto-links any plain-text URL ("www.foo.com" → `<a href="http://www.foo.com">`)
 * when HTML is loaded. Klaviyo's source often has URL-looking text as unlinked
 * plain text (e.g. the footer website line) — preserving that on import means
 * suppressing magic-url.
 *
 * We insert a zero-width space after `www` / after the `//` of a scheme so the
 * magic-url regex can no longer match. The URL remains visually identical and
 * copy-pastes the same in most contexts; Quill never auto-wraps it in <a>.
 * Already-linked text (content inside an <a> tag) is left alone.
 */
const URL_LIKE_RE =
  /\b(https?:\/\/|www\.)[a-zA-Z0-9][-a-zA-Z0-9._/?=&#%+~]*\.[a-zA-Z]{2,}/g;

function suppressUrlAutolink(html: string): string {
  // Split on <a>...</a> so we only touch text outside of real links.
  const parts = html.split(/(<a\b[^>]*>[\s\S]*?<\/a>)/gi);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // already-linked segment
      return part.replace(URL_LIKE_RE, (match) => {
        if (match.startsWith("http")) {
          // insert ZWSP right after "//"
          const cut = match.indexOf("//") + 2;
          return match.slice(0, cut) + "\u200B" + match.slice(cut);
        }
        // starts with "www." — insert ZWSP between "www" and "."
        return "www\u200B" + match.slice(3);
      });
    })
    .join("");
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
 * Walk every `font-family:` declaration in the text HTML and pick the
 * custom (non-web-safe) font that appears most often as the primary
 * (first non-web-safe) entry of each stack. Returns null if nothing
 * non-web-safe was used inline.
 *
 * Klaviyo wraps headline spans with stacks like
 *   "Poppins, 'Helvetica Neue', Helvetica, Arial, sans-serif"
 * The brand font always leads; everything after is a fallback.
 *
 * Used to hoist the inline font to the block level so Redo's Quill
 * editor whitelists it (else Quill strips the inline font-family).
 */
export function extractDominantCustomFont(html: string): string | null {
  const decoded = decodeHtmlEntities(html);
  const counts = new Map<string, number>();
  FONT_FAMILY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FONT_FAMILY_RE.exec(decoded)) !== null) {
    for (const raw of parseFontList(match[1]!)) {
      const normalized = normalizeFontFamilyName(
        raw.replace(/-Klaviyo-Hosted$/i, "").trim(),
      );
      if (!normalized) continue;
      if (WEB_SAFE_FONTS.has(normalized.toLowerCase())) continue;
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
      break; // only count the first (primary) non-web-safe font per stack
    }
  }
  if (counts.size === 0) return null;
  let best: string | null = null;
  let bestCount = -1;
  for (const [family, count] of counts) {
    if (count >= bestCount) {
      best = family;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Redo brand-kit convention: each font weight is a separate CustomFontFamily
 * (e.g. "Poppins SemiBold") rather than multiple styles under one family.
 * To render Klaviyo's `<span style="font-family: Poppins; font-weight: 600">`
 * correctly in Redo's Quill editor, rewrite the span to
 * `<span style="font-family: 'Poppins SemiBold'">` and drop the font-weight
 * (Quill's bold blot is binary and would strip 600 anyway).
 *
 * Only rewrites spans where the primary font is non-web-safe. Web-safe
 * fonts keep their font-weight so the email client handles bold normally.
 */
function rewriteWeightedCustomFontSpans(html: string): string {
  return html.replace(/style\s*=\s*"([^"]*)"/gi, (full, styleStr) => {
    const fontFamilyMatch = /font-family:\s*([^;]+)/i.exec(styleStr);
    const fontWeightMatch = /font-weight:\s*(\d{3}|bold|bolder)\b/i.exec(
      styleStr,
    );
    if (!fontFamilyMatch) return full;

    const families = parseFontList(fontFamilyMatch[1]!);
    const rawPrimary = families[0];
    if (!rawPrimary) return full;
    // Strip Klaviyo's self-hosting suffix and normalize CamelCase so the
    // inline span's font name matches what we register in the brand kit.
    const primary = normalizeFontFamilyName(
      rawPrimary.replace(/-Klaviyo-Hosted$/i, "").trim(),
    );
    if (!primary || WEB_SAFE_FONTS.has(primary.toLowerCase())) return full;

    // Resolve weight: default to 400 if not specified on this span.
    let weight = 400;
    if (fontWeightMatch) {
      const w = fontWeightMatch[1]!.toLowerCase();
      if (w === "bold" || w === "bolder") weight = 700;
      else weight = parseInt(w, 10);
    }

    const weightedName = weightedFamilyName(primary, weight);
    // Always quote: names with spaces ("Poppins SemiBold") require it.
    const rest = families
      .slice(1)
      .map((f) => (/\s/.test(f) || /['"]/.test(f) ? `'${f}'` : f))
      .join(", ");
    const newFamilyValue = rest
      ? `'${weightedName}', ${rest}`
      : `'${weightedName}'`;

    let newStyle = styleStr.replace(
      fontFamilyMatch[0],
      `font-family: ${newFamilyValue}`,
    );
    if (fontWeightMatch) {
      newStyle = newStyle.replace(fontWeightMatch[0], "");
    }
    // Clean up double semicolons / trailing semicolon from removed declarations
    newStyle = newStyle.replace(/;;+/g, ";").replace(/^\s*;\s*/, "").replace(/;\s*$/, "");

    return `style="${newStyle}"`;
  });
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
  // Klaviyo often nests <a> inside a colored <span> while leaving the <a>
  // unstyled. The rendered color is the span's, not the link's, but
  // reading only $firstLink misses that — the imported link color falls
  // back to the outer div's color (or browser default blue) and shows up
  // wrong against a dark background. Walk up from the link until we hit
  // an ancestor with an inline `color`, stopping at the text td.
  let inheritedLinkColor: string | undefined;
  if ($firstLink.length > 0) {
    let cur: cheerio.Cheerio<El> = $firstLink.parent() as cheerio.Cheerio<El>;
    let guard = 0;
    while (cur.length > 0 && guard++ < 10 && (cur[0] as any) !== ($td[0] as any)) {
      const style = parseInlineStyles((cur as any).attr("style"));
      if (style["color"]) {
        inheritedLinkColor = style["color"];
        break;
      }
      cur = cur.parent() as cheerio.Cheerio<El>;
    }
  }

  textHtml = stripEmptyTables(textHtml);
  textHtml = stripStandaloneCoupons(textHtml);
  textHtml = suppressUrlAutolink(textHtml);
  textHtml = substituteSystemFontsInHtml(textHtml);
  textHtml = rewriteWeightedCustomFontSpans(textHtml);
  textHtml = wrapText(textHtml);

  // Klaviyo often sets the outer div to text-align:left (its default)
  // but puts an explicit override on every inner content div (e.g.
  // text-align: center on each paragraph). The visual result is whatever
  // the inner divs say — reading only the outer emits the wrong block
  // alignment.
  //
  // Strategy: if inner block-level elements (divs / paragraphs / h1-h6
  // inside the outer div) all share a single text-align value, use that
  // as the block's effective alignment. Otherwise fall back to outer.
  const outerAlign = divStyle["text-align"];
  const innerAligns = $div
    .children()
    .toArray()
    .map((el) => parseInlineStyles($(el).attr("style"))["text-align"])
    .filter((a) => a && a !== "")
    .map((a) => a!.toLowerCase());
  const uniqueInner = [...new Set(innerAligns)];
  const textAlign =
    innerAligns.length > 0 &&
    uniqueInner.length === 1 &&
    uniqueInner[0] !== outerAlign
      ? uniqueInner[0]
      : outerAlign;
  const lineHeight = divStyle["line-height"];

  // Bake alignment + line-height into the HTML since Redo's TextBlock schema
  // has no textAlign/lineHeight fields — they'd be stripped on import.
  //
  // Preferred target: <p> tags (normal text paragraphs).
  // Fallback: content that's wrapped in a non-<p> block element (e.g. <div>
  // from Klaviyo's short-text UCBs) won't have any <p> to inject into, so
  // wrap the whole content in a styled <div>.
  if (textAlign || lineHeight) {
    const inlineStyle = [
      textAlign ? `text-align:${textAlign}` : "",
      lineHeight ? `line-height:${lineHeight}` : "",
    ].filter(Boolean).join(";");
    if (/<p(?=[\s>])/.test(textHtml)) {
      textHtml = textHtml.replace(/<p(?=[\s>])/g, `<p style="${inlineStyle}"`);
    } else {
      textHtml = `<div style="${inlineStyle}">${textHtml}</div>`;
    }
  }

  // Redo's Quill editor only whitelists the block-level `fontFamily` as a
  // valid inline font. If the text has inline <span style="font-family:
  // Poppins"> but the block-level is Helvetica Neue, Quill strips the span's
  // font. Hoist the dominant custom font used inline so the inline
  // declarations survive the round-trip AND the block's font dropdown
  // reflects the visible brand font.
  const divFontFamily = parseFontFamily(divStyle["font-family"]);
  const inlineCustomFont = extractDominantCustomFont(textHtml);
  const fontFamily = inlineCustomFont ?? divFontFamily;

  const sectionColor =
    tdStyle["background-color"] ||
    tdStyle["background"] ||
    findAncestorBackgroundColor($td) ||
    "#ffffff";

  // Contrast guard for text + link colors. Klaviyo emits text blocks where
  // the resolved color (block-level div, browser-default link, etc.) has
  // very poor contrast against a dark section bg — black-on-black text or
  // Klaviyo's CSS-default `#15c` blue link on a black bg. The block reads
  // unreadable in Redo. Below a 3:1 ratio (universally unreadable, well
  // under WCAG AA) we swap to the bg-contrasting fill. Inline span colors
  // override per-segment so this only fires for the block-level default,
  // and only when the existing source value would actually fail to render.
  const rawTextColor = parseColor(divStyle["color"]);
  const rawLinkColor = parseColor(
    linkStyle["color"] || inheritedLinkColor || divStyle["color"],
  );
  const contrastFloor = 3;
  const textColor = applyContrastFloor(rawTextColor, sectionColor, contrastFloor);
  const linkColor = applyContrastFloor(rawLinkColor, sectionColor, contrastFloor);

  return {
    type: EmailBlockType.TEXT,
    blockId: nextId(),
    // Sum padding across the kl-text td + its wrapping tds. Klaviyo
    // commonly puts horizontal section padding on the outer wrapper td
    // while keeping the inner kl-text td at zero — reading the inner
    // alone drops the outer 18px left/right.
    sectionPadding: sumAncestorPadding($td),
    sectionColor,
    text: textHtml,
    textColor,
    fontSize: parseFontSize(divStyle["font-size"]),
    fontFamily,
    linkColor,
    ...(textAlign ? { textAlign } : {}),
    ...(lineHeight ? { lineHeight } : {}),
  };
}

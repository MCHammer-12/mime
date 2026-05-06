import type { DiscountBlock, Section, TextBlock } from "../../renderer/types.js";
import {
  Alignment,
  EmailBlockType,
  EmailBuilderFontWeight,
  type Padding,
} from "../../renderer/types.js";
import {
  findAncestorBackgroundColor,
  parseColor,
  parseFontFamily,
  parseFontSize,
  parseInlineStyles,
  parsePx,
} from "../style-utils.js";
import { type $, type El, nextId } from "../helpers.js";
import { parseTextBlock } from "./text.js";
import type { ParseContext } from "../index.js";
import type * as cheerio from "cheerio";

/**
 * Match a standalone {% coupon_code 'Name' %} inside a text block's inner HTML.
 * "Standalone" means the coupon sits on its own line — left and right boundaries
 * are a <br/> or the start/end of the HTML string. The coupon may be wrapped
 * in a <span> carrying font styling that we want to transfer to the discount block.
 *
 * Captures:
 *   [1] = opening <span ...> tag (may be empty)
 *   [2] = coupon name
 */
const STANDALONE_COUPON_SPLIT_RE =
  /(?:^|<br\s*\/?>\s*)(?:<br\s*\/?>\s*)?(<span[^>]*>)?\s*\{%\s*coupon_code\s*'([^']*)'?\s*%\}\s*(?:<\/span>)?\s*(?=<br\s*\/?>|$)(?:<br\s*\/?>\s*)?(?:<br\s*\/?>\s*)?/gi;

/**
 * If the text TD contains one or more standalone {% coupon_code %} variables,
 * split it into a sequence of [text, discount, text, ...] blocks. Returns null
 * if no standalone coupons are found (let the normal text parser handle it).
 *
 * Inline coupons (mid-sentence) are intentionally ignored here — they need an
 * AI rewrite pass after deterministic parsing.
 */
export function tryParseDiscountFromText(
  $: $,
  $td: cheerio.Cheerio<El>,
  ctx: ParseContext,
): Section[] | null {
  const $div = $td.children("div").first();
  if ($div.length === 0) return null;
  const html = $div.html() ?? "";

  STANDALONE_COUPON_SPLIT_RE.lastIndex = 0;
  const matches: { index: number; length: number; span: string; name: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = STANDALONE_COUPON_SPLIT_RE.exec(html)) !== null) {
    matches.push({
      index: m.index,
      length: m[0].length,
      span: m[1] ?? "",
      name: m[2] ?? "",
    });
    if (m[0].length === 0) STANDALONE_COUPON_SPLIT_RE.lastIndex++;
  }
  if (matches.length === 0) return null;

  const tdStyle = parseInlineStyles($td.attr("style"));
  const divStyle = parseInlineStyles($div.attr("style"));
  const sectionColor =
    tdStyle["background-color"] ||
    tdStyle["background"] ||
    findAncestorBackgroundColor($td) ||
    "#ffffff";

  const blocks: Section[] = [];
  let cursor = 0;

  for (const match of matches) {
    const before = html.slice(cursor, match.index);
    if (hasVisibleContent(before)) {
      const tb = textBlockFromSegment($, $td, before, ctx);
      if (tb) blocks.push(tb);
    }

    const inherited = findInheritedStyles(html, match.index);
    blocks.push(
      buildDiscountBlock(match.span, match.name, tdStyle, divStyle, inherited, sectionColor),
    );

    cursor = match.index + match.length;
  }

  const tail = html.slice(cursor);
  if (hasVisibleContent(tail)) {
    const tb = textBlockFromSegment($, $td, tail, ctx);
    if (tb) blocks.push(tb);
  }

  return blocks;
}

function hasVisibleContent(html: string): boolean {
  return html.replace(/<[^>]+>/g, "").replace(/&nbsp;|\s/g, "").length > 0;
}

function textBlockFromSegment(
  $: $,
  $td: cheerio.Cheerio<El>,
  segmentHtml: string,
  ctx: ParseContext,
): TextBlock | null {
  const $clone = $td.clone();
  $clone.children("div").first().html(segmentHtml);
  return parseTextBlock($, $clone, ctx);
}

function extractStyleAttr(spanTag: string): string | undefined {
  const m = spanTag.match(/style\s*=\s*"([^"]*)"/i) ??
    spanTag.match(/style\s*=\s*'([^']*)'/i);
  return m ? m[1] : undefined;
}

function normalizeFontWeight(value: string | undefined): EmailBuilderFontWeight {
  if (!value) return EmailBuilderFontWeight.NORMAL;
  const v = value.trim().toLowerCase();
  if (v === "bold" || v === "bolder") return EmailBuilderFontWeight.BOLD;
  const num = parseInt(v, 10);
  if (!isNaN(num) && num >= 600) return EmailBuilderFontWeight.BOLD;
  return EmailBuilderFontWeight.NORMAL;
}

function normalizeAlignment(value: string | undefined): Alignment {
  const v = (value || "").trim().toLowerCase();
  if (v === "right") return Alignment.RIGHT;
  if (v === "left") return Alignment.LEFT;
  return Alignment.CENTER;
}

function parsePaddingFromTd(style: Record<string, string>): Padding {
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
    if (parts.length === 1) top = right = bottom = left = parts[0]!;
    else if (parts.length === 2) {
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

/**
 * Walk the HTML up to `position` tracking still-open containers
 * (<div>, <p>, <td>, <span>) and their inline styles. Returns the
 * effective inherited styles at `position` — the innermost set value
 * for each CSS property wins.
 *
 * Not a full HTML parser — self-closing tags (<br/>, <img/>) are skipped
 * and we ignore everything but the four container tags.
 */
function findInheritedStyles(
  html: string,
  position: number,
): Record<string, string> {
  const prefix = html.slice(0, position);
  const tagRe = /<(\/?)(div|p|td|span)(\s[^>]*)?\/?>/gi;
  const stack: Record<string, string>[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(prefix)) !== null) {
    const closing = m[1] === "/";
    if (closing) {
      stack.pop();
    } else {
      const attrs = m[3] ?? "";
      const styleMatch = attrs.match(/style\s*=\s*"([^"]*)"/i);
      stack.push(styleMatch ? parseInlineStyles(styleMatch[1]) : {});
    }
  }
  const effective: Record<string, string> = {};
  for (const styles of stack) {
    for (const key of Object.keys(styles)) effective[key] = styles[key];
  }
  return effective;
}

function buildDiscountBlock(
  spanTag: string,
  _couponName: string,
  tdStyle: Record<string, string>,
  divStyle: Record<string, string>,
  inherited: Record<string, string>,
  sectionColor: string,
): DiscountBlock {
  const spanStyle = spanTag
    ? parseInlineStyles(extractStyleAttr(spanTag))
    : {};

  // Cascade: innermost wins. Span around coupon > inherited wrappers > outer div.
  const pick = (prop: string): string | undefined =>
    spanStyle[prop] || inherited[prop] || divStyle[prop];

  const textColor = parseColor(pick("color"));
  const fontFamily = parseFontFamily(pick("font-family"));
  const fontSize = parseFontSize(pick("font-size"));
  const fontWeight = normalizeFontWeight(pick("font-weight"));
  const alignment = normalizeAlignment(pick("text-align"));

  const sectionPadding = parsePaddingFromTd(tdStyle);

  return {
    type: EmailBlockType.DISCOUNT,
    blockId: nextId(),
    sectionPadding,
    sectionColor,
    alignment,
    fontFamily,
    fontWeight,
    fontSize,
    textColor,
    blockBackgroundColor: sectionColor,
  };
}

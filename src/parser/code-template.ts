/**
 * Parser for Klaviyo `editor_type: CODE` templates — hand-coded email HTML
 * that doesn't use Klaviyo's block editor (so no `kl-*` / `gxp-kl-*` classes).
 *
 * Assumes the common "600px email table" convention:
 *   <body>
 *     <table width="100%">  (outer, often background color)
 *       <tr><td>
 *         <table max-width:600px>  (container)
 *           <tr><td> ... SECTION 1 ... </td></tr>
 *           <tr><td> ... SECTION 2 ... </td></tr>
 *           ...
 *         </table>
 *       </td></tr>
 *     </table>
 *   </body>
 *
 * Each top-level <tr> of the container becomes a visual section. Inside a
 * section <td> we walk direct children, accumulating text-like nodes and
 * flushing on block-breaking elements (<img>, button-table, line-table,
 * column-table).
 */

import * as cheerio from "cheerio";
import type { $, El } from "./helpers.js";
import type {
  ButtonBlock,
  ColumnBlock,
  ImageBlock,
  LineBlock,
  NonRecursiveBlock,
  Section,
  SpacerBlock,
  TextBlock,
} from "../renderer/types.js";
import {
  Alignment,
  ButtonLinkType,
  EmailBlockType,
  ImageType,
  Size,
  VerticalAlignment,
} from "../renderer/types.js";
import {
  parseColor,
  parseFontFamily,
  parseFontSize,
  parseInlineStyles,
  parsePadding,
  parsePx,
} from "./style-utils.js";
import { nextId } from "./helpers.js";
import { classifyKlaviyoUrl } from "./url-mapping.js";
import type { ParseContext, ParseResult } from "./index.js";

type $El = cheerio.Cheerio<El>;

// ─── Entry point ─────────────────────────────────────────────────

/** Strip trailing slashes; reject obviously-empty / non-http URLs. */
function normalizeStoreUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

export function parseCodeTemplateHtml(
  html: string,
  opts: { storeUrl?: string | null } = {},
): ParseResult {
  const $ = cheerio.load(html);
  const ctx: ParseContext = {
    warnings: [],
    unsupportedFeatures: [],
    reviewItems: [],
    skippedBlocks: [],
    storeUrl: normalizeStoreUrl(opts.storeUrl),
  };

  const bodyStyle = parseInlineStyles($("body").attr("style"));
  const bodyBackgroundColor = bodyStyle["background-color"] || "#ffffff";

  const container = findContainer($);
  if (!container) {
    ctx.warnings.push(
      "CODE template: could not locate 600px container; deep-walking body",
    );
    const fallback = deepWalkContent($, $("body").first(), ctx, true);
    return {
      sections: fallback,
      ...ctx,
      bodyBackgroundColor,
    };
  }

  const sections: Section[] = [];

  if (container.kind === "table") {
    // Direct child <tr> of the container <table> or its <tbody>
    const $rows = directTrChildren(container.$el);
    $rows.each((_, tr) => {
      const $tr = $(tr);
      const $tds = $tr.children("td");
      if ($tds.length === 0) return;

      if ($tds.length === 1) {
        // Normal single-column row: the td may contain a nested container
        // (wrapper emails sometimes double-nest) or a full section.
        const $td = $tds.first();
        const nested = tryNestedContainer($, $td);
        if (nested) {
          directTrChildren(nested).each((_, innerTr) => {
            const $innerTds = $(innerTr).children("td");
            if ($innerTds.length === 1) {
              sections.push(...parseSectionTd($, $innerTds.first(), ctx));
            } else if ($innerTds.length > 1) {
              sections.push(...parseMultiColRow($, $innerTds, ctx));
            }
          });
        } else {
          sections.push(...parseSectionTd($, $td, ctx));
        }
      } else {
        sections.push(...parseMultiColRow($, $tds, ctx));
      }
    });
  } else {
    // div-wrapped template (Hypermatic / Stripo / MSO-heavy): scan content
    // depth-first, emitting blocks as structures are identified.
    sections.push(...deepWalkContent($, container.$el, ctx));
  }

  return { sections, ...ctx, bodyBackgroundColor };
}

// ─── Container discovery ─────────────────────────────────────────

type ContainerKind = "table" | "div";

/**
 * Find the email's 600px container. Preference order:
 *   1. Zaymo / Stripo root: `<div id="bodyTable">` or `<div class="root-container">`.
 *      Picking this first deduplicates Zaymo-built templates that emit two
 *      parallel content trees (one inside #bodyTable, one bare in body).
 *   2. `<table>` constrained to ~600px (`max-width:600`, `width:600px`, or
 *      `width="600"` attr).
 *   3. `<div>` constrained to ~600px (`max-width:600px` inline).
 *
 * Outlook-only candidates (class `kl-section-outlook`) are skipped. They're
 * normally inside `<!--[if mso]>` blocks and hence stripped as comments by
 * cheerio, but the filter guards the cases where MSO comment parsing diverges.
 */
function findContainer($: $): { kind: ContainerKind; $el: $El } | null {
  // 1. Zaymo / Stripo root marker — single canonical email body.
  const root = $("div#bodyTable, div.root-container").first();
  if (root.length > 0) {
    return { kind: "div", $el: root };
  }

  // 2. Inner table constrained to email width.
  const tableCandidates = $("table")
    .toArray()
    .map((el) => $(el))
    .filter(($t) => !isOutlookOnly($t))
    .filter(($t) => {
      const style = parseInlineStyles($t.attr("style"));
      const widthAttr = ($t.attr("width") || "").trim();
      return (
        is600(style["max-width"]) ||
        is600(style["width"]) ||
        widthAttr === "600"
      );
    });
  if (tableCandidates.length > 0) {
    return { kind: "table", $el: tableCandidates[0]! };
  }

  // 3. Div-wrapped templates (Hypermatic / Stripo / MSO-heavy).
  const divCandidates = $("div")
    .toArray()
    .map((el) => $(el))
    .filter(($d) => !isOutlookOnly($d))
    .filter(($d) => {
      const style = parseInlineStyles($d.attr("style"));
      return is600(style["max-width"]) || is600(style["width"]);
    });
  if (divCandidates.length > 0) {
    return { kind: "div", $el: divCandidates[0]! };
  }

  return null;
}

/** True if the CSS value starts with "600" (e.g. "600px", "600"). */
function is600(value: string | undefined): boolean {
  if (!value) return false;
  return /^\s*600(?:\s|px|;|$)/i.test(value);
}

/** True if this element is part of the Outlook-only render branch. */
function isOutlookOnly($el: $El): boolean {
  const cls = ($el.attr("class") || "").toLowerCase();
  return cls.includes("kl-section-outlook");
}

function tryNestedContainer($: $, $td: $El): $El | null {
  const $inner = $td.children("table").first();
  if ($inner.length === 0) return null;
  const style = parseInlineStyles($inner.attr("style"));
  const widthAttr = ($inner.attr("width") || "").trim();
  if (
    /max-width\s*:\s*600/.test($inner.attr("style") || "") ||
    style["max-width"]?.startsWith("600") ||
    widthAttr === "600"
  ) {
    return $inner;
  }
  return null;
}

function directTrChildren($table: $El): $El {
  // Cheerio tables usually auto-insert <tbody>; handle both cases.
  const $tbody = $table.children("tbody").first();
  if ($tbody.length > 0) return $tbody.children("tr");
  return $table.children("tr");
}

// ─── Section parsing ─────────────────────────────────────────────

/**
 * A section <td> can contain multiple visual blocks stacked vertically
 * (e.g. product card: image + title + price + button). Walk direct children,
 * group consecutive text-like nodes, flush on block-breaking elements.
 */
function parseSectionTd(
  $: $,
  $td: $El,
  ctx: ParseContext,
): Section[] {
  const out: Section[] = [];
  const tdStyle = parseInlineStyles($td.attr("style"));
  const sectionPadding = parsePadding(tdStyle);
  const sectionColor =
    tdStyle["background-color"] || tdStyle["background"] || "#ffffff";
  const tdAlign = ($td.attr("align") || "").toLowerCase();

  // Check for empty td → SPACER
  const rawText = $td.text().replace(/ /g, " ").trim();
  const hasVisual =
    rawText.length > 0 ||
    $td.find("img").length > 0 ||
    $td.find("hr").length > 0 ||
    $td.find("table").length > 0;
  if (!hasVisual) {
    out.push(makeSpacer(sectionPadding, sectionColor));
    return out;
  }

  // Walk direct children, grouping into blocks.
  const children = $td.contents().toArray();
  let textBuffer: El[] = [];

  const flushText = () => {
    if (textBuffer.length === 0) return;
    const block = buildTextBlockFromFragments(
      $,
      textBuffer,
      $td,
      tdStyle,
      tdAlign,
      sectionPadding,
      sectionColor,
    );
    if (block) out.push(block);
    textBuffer = [];
  };

  for (const child of children) {
    if (child.type === "text") {
      if ((child.data || "").trim().length > 0) textBuffer.push(child);
      continue;
    }
    if (child.type !== "tag") continue;
    const tag = child.tagName.toLowerCase();

    // HR → line block
    if (tag === "hr") {
      flushText();
      const line = buildLineFromHr(
        $,
        $(child),
        sectionPadding,
        sectionColor,
      );
      if (line) out.push(line);
      continue;
    }

    // Bare <img>
    if (tag === "img") {
      flushText();
      const img = buildImageBlock(
        $,
        $(child),
        null,
        sectionPadding,
        sectionColor,
        tdAlign,
        ctx,
      );
      if (img) out.push(img);
      continue;
    }

    // <a><img/></a> — link wrapping a single image, and no other
    // meaningful content. Treat as IMAGE with clickthroughUrl.
    if (tag === "a") {
      const $a = $(child);
      const $imgs = $a.children("img");
      const aText = $a.text().replace(/ /g, " ").trim();
      if ($imgs.length === 1 && aText.length === 0) {
        flushText();
        const img = buildImageBlock(
          $,
          $imgs.first(),
          $a.attr("href") || null,
          sectionPadding,
          sectionColor,
          tdAlign,
          ctx,
        );
        if (img) out.push(img);
        continue;
      }
      // Otherwise treat the anchor as inline text.
      textBuffer.push(child);
      continue;
    }

    // <table> — classify
    if (tag === "table") {
      const classification = classifyTable($, $(child));
      if (classification === "button") {
        flushText();
        const btn = buildButtonFromTable(
          $,
          $(child),
          sectionPadding,
          sectionColor,
          tdAlign,
          ctx,
        );
        if (btn) out.push(btn);
        continue;
      }
      if (classification === "line") {
        flushText();
        const line = buildLineFromTable(
          $,
          $(child),
          sectionPadding,
          sectionColor,
        );
        if (line) out.push(line);
        continue;
      }
      if (classification === "column") {
        flushText();
        out.push(
          ...buildColumnFromTable(
            $,
            $(child),
            sectionPadding,
            sectionColor,
            ctx,
          ),
        );
        continue;
      }
      // Unknown table — recurse into its cells (dig for content).
      flushText();
      const inner = parseTableAsBlocks($, $(child), ctx);
      if (inner.length === 0) {
        ctx.warnings.push(
          `CODE template: table inside section with unknown shape; inner text="${$(child).text().trim().slice(0, 60)}"`,
        );
      }
      out.push(...inner);
      continue;
    }

    // Text-like block: p, h1-h6, div, span, strong, em, small, b, i, u
    // We treat it as text content and accumulate.
    textBuffer.push(child);
  }

  flushText();

  // If we produced nothing visible (edge case), emit a spacer so the row
  // still contributes padding.
  if (out.length === 0) {
    out.push(makeSpacer(sectionPadding, sectionColor));
  }

  return out;
}

// ─── Table classification ────────────────────────────────────────

type TableKind = "button" | "line" | "column" | "other";

function classifyTable($: $, $table: $El): TableKind {
  const $rows = directTrChildren($table);
  if ($rows.length === 0) return "other";

  // Column: any row with ≥2 content tds.
  let hasMultiCellRow = false;
  $rows.each((_, tr) => {
    const $tds = $(tr).children("td");
    if ($tds.length < 2) return;
    let contentCount = 0;
    $tds.each((_, td) => {
      const $td = $(td);
      const hasImg = $td.find("img").length > 0;
      const hasText = $td.text().replace(/ /g, " ").trim().length > 0;
      if (hasImg || hasText) contentCount++;
    });
    if (contentCount >= 2) hasMultiCellRow = true;
  });
  if (hasMultiCellRow) return "column";

  // Single-row single-td analysis for button/line
  if ($rows.length === 1) {
    const $tds = $rows.first().children("td");
    if ($tds.length === 1) {
      const $td = $tds.first();
      const style = parseInlineStyles($td.attr("style"));
      const bgColor =
        style["background-color"] ||
        style["background"] ||
        $td.attr("bgcolor") ||
        "";
      const borderRadius = style["border-radius"];
      const $a = $td.find("a").first();
      const hasLink = $a.length > 0;
      const linkText = $a.text().trim();

      if (hasLink && bgColor && linkText.length > 0) return "button";
      // Button with transparent bg but strong border?
      if (hasLink && style["border"] && linkText.length > 0) return "button";

      // Line: border-top on the td, no meaningful content (or just nbsp/spaces)
      const borderTop = style["border-top"];
      const bodyText = $td.text().replace(/ /g, " ").trim();
      if (borderTop && bodyText.length === 0) return "line";
    }
  }

  return "other";
}

// ─── Builders: text ──────────────────────────────────────────────

function buildTextBlockFromFragments(
  $: $,
  frags: El[],
  $td: $El,
  tdStyle: Record<string, string>,
  tdAlign: string,
  sectionPadding: { top: number; right: number; bottom: number; left: number },
  sectionColor: string,
): TextBlock | null {
  // Gather outerHTML of each fragment.
  const parts: string[] = [];
  for (const f of frags) {
    if (f.type === "text") {
      const s = (f.data || "").trim();
      if (s.length > 0) parts.push(s);
      continue;
    }
    parts.push($.html($(f)));
  }
  let text = parts.join("").trim();
  if (text.length === 0) return null;

  // Default styling reads from first substantive child (or td). Scan for the
  // first <p> or <h*> style; fall back to td.
  let firstChild: $El | null = null;
  for (const f of frags) {
    if (f.type !== "tag") continue;
    firstChild = $(f);
    break;
  }
  const firstStyle = firstChild
    ? parseInlineStyles(firstChild.attr("style"))
    : {};
  const fontFamily = parseFontFamily(
    firstStyle["font-family"] || tdStyle["font-family"],
  );
  const fontSize = parseFontSize(
    firstStyle["font-size"] || tdStyle["font-size"],
  );
  const textColor = parseColor(firstStyle["color"] || tdStyle["color"]);
  const lineHeight = firstStyle["line-height"] || tdStyle["line-height"];
  const textAlign =
    firstStyle["text-align"] || tdStyle["text-align"] || tdAlign || undefined;

  // Link color: first <a> inside the collected fragments
  let linkColor = textColor;
  const linkMatch = text.match(
    /<a\b[^>]*style="[^"]*color\s*:\s*([^;"]+)/i,
  );
  if (linkMatch) linkColor = parseColor(linkMatch[1]);

  // If content is wrapped in a single block element, use outer; else wrap.
  if (!/^<(p|h[1-6]|div|table|blockquote|ul|ol|pre)\b/i.test(text)) {
    text = `<p>${text}</p>`;
  }

  return {
    type: EmailBlockType.TEXT,
    blockId: nextId(),
    sectionPadding,
    sectionColor,
    text,
    textColor,
    fontSize,
    fontFamily,
    linkColor,
    ...(lineHeight ? { lineHeight } : {}),
    ...(textAlign ? { textAlign } : {}),
  };
}

// ─── Builders: image ─────────────────────────────────────────────

function buildImageBlock(
  $: $,
  $img: $El,
  clickUrl: string | null,
  sectionPadding: { top: number; right: number; bottom: number; left: number },
  sectionColor: string,
  tdAlign: string,
  ctx: ParseContext,
): ImageBlock | null {
  const src = $img.attr("src") || "";
  if (!src) return null;
  const alt = $img.attr("alt") || "";
  const widthAttr = $img.attr("width");
  const heightAttr = $img.attr("height");
  const style = parseInlineStyles($img.attr("style"));
  const widthPx = parsePx(style["width"]) ?? parsePx(widthAttr ?? "");
  const heightPx = parsePx(style["height"]) ?? parsePx(heightAttr ?? "");
  const aspectRatio =
    widthPx && heightPx && heightPx > 0 ? widthPx / heightPx : undefined;

  // Shrink the image to its declared width by widening sectionPadding —
  // Redo's renderer sizes <img width="..."> as
  // (EMAIL_MAX_WIDTH_PX - sectionPadding.left - sectionPadding.right).
  // Honor td/img align for asymmetric padding (left-align dumps the slack
  // on the right, etc.).
  applyImageWidth(sectionPadding, widthPx, tdAlign);

  // No width information at all → renders full-width (600px). Common in
  // hand-coded CODE templates where the merchant assumed defaults; flag
  // for review so they can decide per-image.
  if (!widthPx) {
    ctx.reviewItems.push({
      blockType: EmailBlockType.IMAGE,
      variableName: "image-width-missing",
      context: src,
    });
  }

  // Map Klaviyo URL variables (e.g. {{ event.URL }} → <storeUrl>/cart)
  // and surface unsupported / review-needed variables on ctx.
  const mapped = clickUrl
    ? classifyKlaviyoUrl(clickUrl, EmailBlockType.IMAGE, ctx)
    : null;

  return {
    type: EmailBlockType.IMAGE,
    blockId: nextId(),
    sectionPadding,
    sectionColor,
    imageUrl: src,
    showCaption: false,
    altText: alt || undefined,
    clickthroughUrl: mapped?.buttonLink ?? clickUrl ?? undefined,
    aspectRatio,
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    horizontalPadding: widthPx ? Size.CUSTOM : Size.MEDIUM,
    verticalPadding: Size.MEDIUM,
    // imageSourceType is optional in Redo's email-template schema. Their
    // enum is { upload, product } only — sending "url" is a 400 Input
    // validation error. Omitting the field means "URL-sourced image"
    // (the default); upload/product are explicit lift cases.
  };
}

/**
 * Mutate sectionPadding to shrink/align the image to `widthPx`. Available
 * width is EMAIL_MAX_WIDTH_PX (600) minus existing horizontal section pad.
 * - tdAlign="left": dumps slack to the right
 * - tdAlign="right": dumps slack to the left
 * - else: centers (split slack evenly, right gets the +1 on odd)
 */
function applyImageWidth(
  sectionPadding: { top: number; right: number; bottom: number; left: number },
  widthPx: number | null | undefined,
  tdAlign: string,
): void {
  if (!widthPx) return;
  const EMAIL_MAX_WIDTH_PX = 600;
  const available =
    EMAIL_MAX_WIDTH_PX - sectionPadding.left - sectionPadding.right;
  if (widthPx >= available) return;
  const slack = available - widthPx;
  if (tdAlign === "left") {
    sectionPadding.right += slack;
  } else if (tdAlign === "right") {
    sectionPadding.left += slack;
  } else {
    const half = Math.floor(slack / 2);
    sectionPadding.left += half;
    sectionPadding.right += slack - half;
  }
}

// ─── Builders: button ────────────────────────────────────────────

function buildButtonFromTable(
  $: $,
  $table: $El,
  sectionPadding: { top: number; right: number; bottom: number; left: number },
  sectionColor: string,
  tdAlign: string,
  ctx: ParseContext,
): ButtonBlock | null {
  const $tr = directTrChildren($table).first();
  const $td = $tr.children("td").first();
  if ($td.length === 0) return null;
  const $a = $td.find("a").first();
  if ($a.length === 0) return null;

  const tdStyle = parseInlineStyles($td.attr("style"));
  const aStyle = parseInlineStyles($a.attr("style"));

  const fillColor =
    tdStyle["background-color"] ||
    tdStyle["background"] ||
    $td.attr("bgcolor") ||
    "#000000";
  const cornerRadius = parsePx(tdStyle["border-radius"] || aStyle["border-radius"]) ?? 0;

  // Padding on the <a> (display:inline-block;padding:...) is the typical place.
  const padding = parsePadding(aStyle);

  // Table / td align determines button horizontal alignment within section
  let alignment: Alignment = Alignment.CENTER;
  const tableAlign = ($table.attr("align") || "").toLowerCase();
  const combined = (tableAlign || tdAlign || "center") as string;
  if (combined === "left") alignment = Alignment.LEFT;
  else if (combined === "right") alignment = Alignment.RIGHT;
  else alignment = Alignment.CENTER;

  // Stroke: only uniform borders count.
  const { strokeColor, strokeWeight } = parseUniformBorder(tdStyle);

  const buttonText = $a.text().trim();
  const href = $a.attr("href") || "";
  // Substitute Klaviyo URL variables (e.g. {{ event.extra.checkout_url }}
  // → <storeUrl>/cart) and surface review-worthy variables on ctx.
  const mapped = href
    ? classifyKlaviyoUrl(href, EmailBlockType.BUTTON, ctx)
    : null;

  return {
    type: EmailBlockType.BUTTON,
    blockId: nextId(),
    sectionPadding,
    sectionColor,
    buttonText,
    fillColor,
    textColor: parseColor(aStyle["color"]),
    strokeColor,
    strokeWeight,
    cornerRadius,
    fontSize: parseFontSize(aStyle["font-size"]),
    fontFamily: parseFontFamily(aStyle["font-family"]),
    alignment,
    padding,
    linkType: ButtonLinkType.WEB_PAGE,
    buttonLink: mapped?.buttonLink ?? href,
  };
}

function parseUniformBorder(style: Record<string, string>): {
  strokeColor: string;
  strokeWeight: number;
} {
  const border = style["border"];
  if (border && border !== "none") {
    const match = border.match(
      /(\d+(?:\.\d+)?)\s*px\s+(?:solid|dashed|dotted)\s+(#[0-9a-fA-F]{3,8}|\w+)/,
    );
    if (match)
      return { strokeWeight: parseFloat(match[1]!), strokeColor: match[2]! };
  }
  return { strokeColor: "transparent", strokeWeight: 0 };
}

// ─── Builders: line ──────────────────────────────────────────────

function buildLineFromTable(
  $: $,
  $table: $El,
  sectionPadding: { top: number; right: number; bottom: number; left: number },
  sectionColor: string,
): LineBlock | null {
  const $td = directTrChildren($table).first().children("td").first();
  if ($td.length === 0) return null;
  const style = parseInlineStyles($td.attr("style"));
  return parseLineFromStyle(style, sectionPadding, sectionColor);
}

function buildLineFromHr(
  $: $,
  $hr: $El,
  sectionPadding: { top: number; right: number; bottom: number; left: number },
  sectionColor: string,
): LineBlock | null {
  const style = parseInlineStyles($hr.attr("style"));
  const borderTop = style["border-top"] || style["border"] || "";
  const borderColor = parseBorderColor(borderTop) || "#cccccc";
  return {
    type: EmailBlockType.LINE,
    blockId: nextId(),
    sectionPadding,
    sectionColor,
    color: borderColor,
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    horizontalPadding: Size.MEDIUM,
    verticalPadding: Size.MEDIUM,
  };
}

function parseLineFromStyle(
  style: Record<string, string>,
  sectionPadding: { top: number; right: number; bottom: number; left: number },
  sectionColor: string,
): LineBlock | null {
  const borderTop = style["border-top"] || style["border-bottom"] || "";
  if (!borderTop) return null;
  const color = parseBorderColor(borderTop) || "#cccccc";
  return {
    type: EmailBlockType.LINE,
    blockId: nextId(),
    sectionPadding,
    sectionColor,
    color,
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    horizontalPadding: Size.MEDIUM,
    verticalPadding: Size.MEDIUM,
  };
}

function parseBorderColor(borderDecl: string): string | null {
  const m = borderDecl.match(
    /(?:solid|dashed|dotted)\s*(?:\d+(?:\.\d+)?\s*px\s*)?(#[0-9a-fA-F]{3,8}|\w+)/,
  );
  return m ? m[1]! : null;
}

// ─── Builders: column ────────────────────────────────────────────

/**
 * Convert a multi-td row (at the container's TR level) into a Redo
 * COLUMN block. Each td becomes one column; inside each, we try to
 * produce a single non-recursive block (first meaningful block wins;
 * if the td is complex, emit a text block with the td's inner HTML).
 */
/**
 * Parse a multi-td row as columns. If any cell has >1 block, bail to
 * flat emission (matches the Klaviyo parser convention — stacked
 * ColumnBlocks break mobile reflow).
 */
function parseMultiColRow(
  $: $,
  $tds: $El,
  ctx: ParseContext,
): Section[] {
  const cellBlockLists: Section[][] = [];
  const widths: number[] = [];
  let sectionPadding = { top: 0, right: 0, bottom: 0, left: 0 };
  let sectionColor = "#ffffff";

  $tds.each((_, td) => {
    const $td = $(td);
    const tdStyle = parseInlineStyles($td.attr("style"));
    if (tdStyle["background-color"]) sectionColor = tdStyle["background-color"];
    const p = parsePadding(tdStyle);
    if (p.top || p.bottom) sectionPadding = p;

    const widthAttr = ($td.attr("width") || "").replace("%", "");
    const widthNum = parseInt(widthAttr, 10);
    if (!isNaN(widthNum)) widths.push(widthNum);

    cellBlockLists.push(parseSectionTd($, $td, ctx));
  });

  if (cellBlockLists.length === 0) return [];

  const anyMulti = cellBlockLists.some((blocks) => blocks.length > 1);
  if (anyMulti) {
    ctx.warnings.push(
      `CODE template: multi-block column cell (${cellBlockLists.map((b) => b.length).join("/")} blocks); bailing to flat section emission`,
    );
    return cellBlockLists.flat();
  }

  const cols: (NonRecursiveBlock | null)[] = cellBlockLists.map(
    (blocks) => {
      const b = blocks[0];
      if (!b) return null;
      if (b.type === EmailBlockType.COLUMN || b.type === EmailBlockType.PRODUCTS) {
        return null;
      }
      return b;
    },
  );

  return [
    {
      type: EmailBlockType.COLUMN,
      blockId: nextId(),
      sectionPadding,
      sectionColor,
      columns: cols,
      columnCount: cols.length,
      gap: 0,
      stackOnMobile: true,
      alignment: VerticalAlignment.TOP,
      columnWidths: widths.length === cols.length ? widths : null,
    },
  ];
}

function buildColumnFromTable(
  $: $,
  $table: $El,
  sectionPadding: { top: number; right: number; bottom: number; left: number },
  sectionColor: string,
  ctx: ParseContext,
): Section[] {
  // Find the first row that has multi-td content.
  const $rows = directTrChildren($table);
  let multiRowEl: El | null = null;
  $rows.each((_, tr) => {
    const $tds = $(tr).children("td");
    if ($tds.length >= 2 && !multiRowEl) multiRowEl = tr;
  });
  if (!multiRowEl) return [];
  const $tds = $(multiRowEl).children("td");
  const blocks = parseMultiColRow($, $tds, ctx);
  // Overwrite padding/color on any ColumnBlock(s) we produced so the
  // outer section's values stick.
  for (const b of blocks) {
    if (b.type === EmailBlockType.COLUMN) {
      b.sectionPadding = sectionPadding;
      b.sectionColor = sectionColor;
    }
  }
  return blocks;
}

// ─── Builders: fallback table → blocks ───────────────────────────

/**
 * Recurse into an unclassified table and try to extract its inner
 * content as a flat list of blocks. Each inner cell is re-entered
 * via parseSectionTd so nested tables get unwrapped.
 */
function parseTableAsBlocks(
  $: $,
  $table: $El,
  ctx: ParseContext,
): Section[] {
  const out: Section[] = [];
  const $rows = directTrChildren($table);
  $rows.each((_, tr) => {
    const $tds = $(tr).children("td");
    $tds.each((_, td) => {
      out.push(...parseSectionTd($, $(td), ctx));
    });
  });
  return out;
}

// ─── Div-wrapped deep walker ─────────────────────────────────────

/**
 * For div-based email templates (Hypermatic / Stripo / heavy MSO wrapping)
 * that don't have a flat <tr>-row structure, walk the DOM depth-first and
 * emit blocks whenever we encounter a recognizable content shape:
 *   - <a><img/></a> or <img/>        → IMAGE block
 *   - a "button-shaped" <table>      → BUTTON block
 *   - a "line-shaped" <table> or <hr>→ LINE block
 *   - a chunk of text-like elements  → TEXT block (accumulated)
 * Once a block is emitted, we skip further descent into that subtree.
 *
 * `isBodyRoot` = true when this is the fallback path that walks <body>
 * directly. In that case, filter out body-level noise (malformed <title>/
 * <meta>, Liquid-only preheader <p>) that wouldn't appear inside a proper
 * email container.
 */
function deepWalkContent(
  $: $,
  $root: $El,
  ctx: ParseContext,
  isBodyRoot: boolean = false,
): Section[] {
  const out: Section[] = [];
  let textFrags: El[] = [];
  const flushText = () => {
    if (textFrags.length === 0) return;
    const block = buildTextBlockFromFragments(
      $,
      textFrags,
      $root,
      {},
      "",
      { top: 0, right: 0, bottom: 0, left: 0 },
      "#ffffff",
    );
    if (block) out.push(block);
    textFrags = [];
  };

  const seen = new Set<El>();
  const isVisualSkip = ($el: $El) => {
    // Skip zero-height / display:none wrappers (preheader text etc.)
    const rawStyle = $el.attr("style") || "";
    const style = parseInlineStyles(rawStyle);
    const dispNone = /display\s*:\s*none/i.test(rawStyle);
    const msoHide = /mso-hide\s*:\s*all/i.test(rawStyle);
    const maxH0 = (style["max-height"] || "").startsWith("0");
    const fontOne = (style["font-size"] || "").startsWith("1px");
    return dispNone || msoHide || maxH0 || fontOne;
  };

  const visit = (el: El) => {
    if (seen.has(el)) return;
    if (el.type === "text") {
      const s = (el.data || "").trim();
      if (s.length > 0) textFrags.push(el);
      return;
    }
    if (el.type !== "tag") return;
    const $el = $(el);
    const tag = el.tagName.toLowerCase();

    if (tag === "script" || tag === "style" || tag === "head") return;
    if (isVisualSkip($el)) return;

    // IMAGE
    if (tag === "img") {
      flushText();
      const img = buildImageBlock(
        $,
        $el,
        null,
        { top: 0, right: 0, bottom: 0, left: 0 },
        "#ffffff",
        "",
        ctx,
      );
      if (img) out.push(img);
      seen.add(el);
      return;
    }

    // <a><img></a> → image with clickthrough
    if (tag === "a") {
      const $imgs = $el.children("img");
      const aText = $el.text().replace(/ /g, " ").trim();
      if ($imgs.length === 1 && aText.length === 0) {
        flushText();
        const img = buildImageBlock(
          $,
          $imgs.first(),
          $el.attr("href") || null,
          { top: 0, right: 0, bottom: 0, left: 0 },
          "#ffffff",
          "",
          ctx,
        );
        if (img) out.push(img);
        seen.add(el);
        return;
      }
      // Anchor with text content → part of a text run. Don't descend into
      // children (they'll be captured by the anchor's outerHTML in text).
      textFrags.push(el);
      return;
    }

    // HR
    if (tag === "hr") {
      flushText();
      const line = buildLineFromHr(
        $,
        $el,
        { top: 0, right: 0, bottom: 0, left: 0 },
        "#ffffff",
      );
      if (line) out.push(line);
      seen.add(el);
      return;
    }

    // TABLE — classify
    if (tag === "table") {
      const classification = classifyTable($, $el);
      if (classification === "button") {
        flushText();
        const btn = buildButtonFromTable(
          $,
          $el,
          { top: 0, right: 0, bottom: 0, left: 0 },
          "#ffffff",
          "",
          ctx,
        );
        if (btn) out.push(btn);
        seen.add(el);
        return;
      }
      if (classification === "line") {
        flushText();
        const line = buildLineFromTable(
          $,
          $el,
          { top: 0, right: 0, bottom: 0, left: 0 },
          "#ffffff",
        );
        if (line) out.push(line);
        seen.add(el);
        return;
      }
      if (classification === "column") {
        flushText();
        // For deep-walk, we can't produce the stacked-column bail-out
        // flat section path reliably — just emit a single column row.
        const $rows = directTrChildren($el);
        let colEmitted = false;
        $rows.each((_, tr) => {
          if (colEmitted) return;
          const $tds = $(tr).children("td");
          if ($tds.length >= 2) {
            out.push(...parseMultiColRow($, $tds, ctx));
            colEmitted = true;
          }
        });
        if (colEmitted) {
          seen.add(el);
          return;
        }
      }
      // Unclassified table: fall through and keep descending.
    }

    // Text-ish tags: if the element has no child elements (just text),
    // treat it as a text fragment rather than descending.
    if (
      ["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"].includes(tag)
    ) {
      textFrags.push(el);
      return;
    }

    // Otherwise, descend into children.
    const children = $el.contents().toArray();
    for (const child of children) visit(child);
  };

  const rootChildren = $root.contents().toArray();
  for (const c of rootChildren) {
    if (isBodyRoot && isBodyNoiseChild($, c)) continue;
    visit(c);
  }
  flushText();

  return out;
}

/** Body-level children that should never produce sections in the fallback
 *  deep-walk path: head-leaks (<title>/<meta>/<link>), and Klaviyo preheader
 *  <p>s whose content is purely Liquid/whitespace. */
function isBodyNoiseChild($: $, el: El): boolean {
  if (el.type !== "tag") return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "title" || tag === "meta" || tag === "link") return true;
  if (tag === "p") {
    const txt = $(el).text().trim();
    if (txt.length === 0) return false;
    // Strip all Liquid tokens; if nothing visible remains, it's a preheader leak.
    const stripped = txt
      .replace(/\{%[\s\S]*?%\}/g, "")
      .replace(/\{\{[\s\S]*?\}\}/g, "")
      .trim();
    if (stripped.length === 0) return true;
  }
  return false;
}

// ─── Spacer helper ───────────────────────────────────────────────

function makeSpacer(
  sectionPadding: { top: number; right: number; bottom: number; left: number },
  sectionColor: string,
): SpacerBlock {
  const height = Math.max(sectionPadding.top + sectionPadding.bottom, 8);
  return {
    type: EmailBlockType.SPACER,
    blockId: nextId(),
    sectionPadding: { top: 0, right: 0, bottom: 0, left: 0 },
    sectionColor,
    height,
  };
}

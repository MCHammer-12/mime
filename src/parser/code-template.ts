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

export function parseCodeTemplateHtml(
  html: string,
  opts: { storeUrl?: string | null } = {},
): ParseResult {
  const $ = cheerio.load(html);
  // Strip trailing slashes; reject non-http so the url-mapping cart-link
  // fallback only fires on a real store URL (mirrors index.ts).
  const rawStore = (opts.storeUrl ?? "").trim().replace(/\/+$/, "");
  const storeUrl = /^https?:\/\//i.test(rawStore) ? rawStore : null;
  const ctx: ParseContext = {
    warnings: [],
    unsupportedFeatures: [],
    reviewItems: [],
    skippedBlocks: [],
    storeUrl,
  };

  const bodyStyle = parseInlineStyles($("body").attr("style"));
  const bodyBackgroundColor = bodyStyle["background-color"] || "#ffffff";

  const container = findContainer($);
  if (!container) {
    ctx.warnings.push(
      "CODE template: could not locate 600px container; deep-walking body",
    );
    const fallback = deepWalkContent($, $("body").first(), ctx);
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

function findContainer($: $): { kind: ContainerKind; $el: $El } | null {
  // Prefer the inner table that's constrained to email width.
  // ─────────────────────────────────────────────────────────────────
  // KEEP THIS FIRST and unchanged. ~270 of Otishi's CODE templates find
  // their container here; reordering or broadening the table match would
  // shift their section output. The Zaymo / inline-width fallbacks below
  // only fire for templates that currently find NO table and deep-walk
  // the whole body (the double-emit case — see #1/#2 in the CODE-fidelity
  // plan), so they're additive, not a behavior change for table templates.
  const tableCandidates = $("table")
    .toArray()
    .map((el) => $(el))
    .filter(($t) => {
      const style = parseInlineStyles($t.attr("style"));
      const widthAttr = ($t.attr("width") || "").trim();
      return (
        /max-width\s*:\s*600/.test(style["max-width"] || "") ||
        /max-width\s*:\s*600/.test($t.attr("style") || "") ||
        widthAttr === "600"
      );
    });
  if (tableCandidates.length > 0) {
    return { kind: "table", $el: tableCandidates[0]! };
  }

  // Zaymo "root-container" convention. Zaymo (app.zaymo.com) renders a
  // Klaviyo email as TWO parallel copies directly under <body> — one in a
  // generic `<div style="display:table">` and one in `<div id="bodyTable"
  // class="root-container">`. Without a recognized container we'd deep-walk
  // the body and emit BOTH copies (Castle Sports RYCBtZ: 33 sections, every
  // block twice). Scoping to the single root-container div deduplicates.
  // Prefer the id'd outer wrapper, else the first .root-container.
  const $byId = $("div#bodyTable").first();
  if ($byId.length > 0) return { kind: "div", $el: $byId };
  const $rootContainer = $("div.root-container").first();
  if ($rootContainer.length > 0) return { kind: "div", $el: $rootContainer };

  // Fallback for div-wrapped templates (Hypermatic / Stripo / MSO-heavy).
  // Match both `max-width:600` and a bare inline `width:600px` — Zaymo and
  // some builders constrain the content div with the latter.
  const divCandidates = $("div")
    .toArray()
    .map((el) => $(el))
    .filter(($d) => {
      const style = parseInlineStyles($d.attr("style"));
      return (
        /max-width\s*:\s*600/.test(style["max-width"] || "") ||
        /(?:^|[^-])width\s*:\s*600px/.test($d.attr("style") || "")
      );
    });
  if (divCandidates.length > 0) {
    return { kind: "div", $el: divCandidates[0]! };
  }

  return null;
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
): ImageBlock | null {
  const src = $img.attr("src") || "";
  if (!src) return null;
  const alt = $img.attr("alt") || "";
  const widthAttr = $img.attr("width");
  const heightAttr = $img.attr("height");
  const style = parseInlineStyles($img.attr("style"));
  const maxWidth = parsePx(style["max-width"]);
  const widthPx = parsePx(style["width"]) ?? parsePx(widthAttr ?? "");
  const heightPx = parsePx(style["height"]) ?? parsePx(heightAttr ?? "");
  const aspectRatio =
    widthPx && heightPx && heightPx > 0 ? widthPx / heightPx : undefined;

  // Alignment: tdAlign wins if set, else margin auto means center
  let alignment: Alignment = Alignment.CENTER;
  if (tdAlign === "left") alignment = Alignment.LEFT;
  else if (tdAlign === "right") alignment = Alignment.RIGHT;

  const block: ImageBlock = {
    type: EmailBlockType.IMAGE,
    blockId: nextId(),
    sectionPadding,
    sectionColor,
    imageUrl: src,
    showCaption: false,
    altText: alt || undefined,
    clickthroughUrl: clickUrl || undefined,
    aspectRatio,
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    horizontalPadding: Size.MEDIUM,
    verticalPadding: Size.MEDIUM,
    // imageSourceType is optional in Redo's email-template schema. Their
    // enum is { upload, product } only — sending "url" is a 400 Input
    // validation error. Omitting the field means "URL-sourced image"
    // (the default); upload/product are explicit lift cases.
  };
  // silence unused alignment var — alignment is handled by sectionPadding
  void alignment;
  void maxWidth;
  return block;
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
  // Rewrite Klaviyo checkout-URL variables ({{ event.extra.checkout_url }}
  // etc.) to <storeUrl>/cart, same as the block-editor button parser. With
  // no storeUrl the variable stays and a reviewItem is pushed for review.
  const mapped = href ? classifyKlaviyoUrl(href, EmailBlockType.BUTTON, ctx) : null;

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
 */
function deepWalkContent(
  $: $,
  $root: $El,
  ctx: ParseContext,
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
    const style = parseInlineStyles($el.attr("style"));
    const dispNone = /display\s*:\s*none/i.test($el.attr("style") || "");
    const maxH0 = (style["max-height"] || "").startsWith("0");
    const fontOne = (style["font-size"] || "").startsWith("1px");
    return dispNone || maxH0 || fontOne;
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
  for (const c of rootChildren) visit(c);
  flushText();

  return out;
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

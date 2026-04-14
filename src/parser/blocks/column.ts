import type {
  ButtonBlock,
  ColumnBlock,
  DiscountBlock,
  ImageBlock,
  NonRecursiveBlock,
  Section,
  TextBlock,
} from "../../renderer/types.js";
import { EmailBlockType, VerticalAlignment } from "../../renderer/types.js";
import {
  parseColor,
  parseFontFamily,
  parseFontSize,
  parseInlineStyles,
  parsePadding,
} from "../style-utils.js";
import { type $, type El, findCls, hasClass, nextId } from "../helpers.js";
import type * as cheerio from "cheerio";

const NESTABLE_TYPES = new Set<EmailBlockType>([
  EmailBlockType.TEXT,
  EmailBlockType.IMAGE,
  EmailBlockType.BUTTON,
  EmailBlockType.DISCOUNT,
]);

/**
 * Parse a multi-column row (multiple kl-column children).
 * Called from the dispatcher for rows with >1 column.
 *
 * Redo's ColumnBlock schema allows exactly one NonRecursiveBlock per column
 * slot. Klaviyo columns can contain multiple stacked wrappers (e.g. image +
 * text story boxes). We handle this by "zippering" wrappers across columns
 * into multiple stacked ColumnBlock sections — one per row-index — with
 * cross-row padding clamped so adjacent sections visually touch.
 *
 * Special cases:
 * - Any column containing a product (emitted by parseProductBlock as its own
 *   ColumnBlock) → bail on the multi-column layout and emit every inner block
 *   as a standalone top-level section. Product blocks have their own internal
 *   columns and can't be nested.
 * - Any column containing a non-nestable block (HEADER/LINE/SPACER/MENU/
 *   SOCIALS) → same bail-out behavior.
 */
export function parseColumnRow(
  $: $,
  $columns: cheerio.Cheerio<El>,
  warnings: string[],
  parseColumnContent: ($: $, $col: cheerio.Cheerio<El>, warnings: string[]) => Section[],
): Section[] {
  const widths: number[] = [];
  let alignment = VerticalAlignment.TOP;
  const perColumnBlocks: Section[][] = [];

  $columns.each((_, col) => {
    const $col = $(col);
    const style = parseInlineStyles($col.attr("style"));
    const widthStr = style["width"];
    const width = widthStr ? parseFloat(widthStr) : 100 / $columns.length;
    widths.push(width);

    const valign = (style["vertical-align"] || "").toLowerCase();
    if (valign === "middle" || valign === "center") alignment = VerticalAlignment.CENTER;
    else if (valign === "bottom") alignment = VerticalAlignment.BOTTOM;

    perColumnBlocks.push(parseColumnContent($, $col, warnings));
  });

  // Bail condition: any column contains a non-nestable block (product,
  // header, line, spacer, menu, socials, or nested column). Emit everything
  // flat, preserving document order within each column.
  const hasNonNestable = perColumnBlocks.some((arr) =>
    arr.some((b) => !NESTABLE_TYPES.has(b.type)),
  );
  if (hasNonNestable) {
    warnings.push(
      `Column row contains a non-nestable block (product or complex layout) — emitting contents as standalone sections.`,
    );
    return perColumnBlocks.flat();
  }

  const $row = $columns.first().parent();
  const stackOnMobile = hasClass($row, "colstack") || $row.hasClass("colstack");
  const { sectionColor } = extractRowContext($, $columns);

  // Zipper: cast nestable blocks into row-indexed ColumnBlock sections.
  const nestablePerColumn: NonRecursiveBlock[][] = perColumnBlocks.map((arr) =>
    arr.filter((b): b is NonRecursiveBlock => NESTABLE_TYPES.has(b.type)),
  );
  const rowCount = Math.max(1, ...nestablePerColumn.map((a) => a.length));

  const sections: ColumnBlock[] = [];
  for (let r = 0; r < rowCount; r++) {
    const isFirstRow = r === 0;
    const isLastRow = r === rowCount - 1;
    const cols = nestablePerColumn.map((arr) => {
      const block = arr[r];
      if (!block) return null;
      // Clamp padding so stacked column sections touch:
      // non-first rows zero top; non-last rows zero bottom.
      return {
        ...block,
        sectionPadding: {
          top: isFirstRow ? block.sectionPadding.top : 0,
          right: block.sectionPadding.right,
          bottom: isLastRow ? block.sectionPadding.bottom : 0,
          left: block.sectionPadding.left,
        },
      };
    });
    sections.push({
      type: EmailBlockType.COLUMN,
      blockId: nextId(),
      sectionPadding: { top: 0, right: 0, bottom: 0, left: 0 },
      sectionColor,
      columns: cols,
      columnCount: $columns.length,
      gap: 0,
      stackOnMobile,
      alignment,
      columnWidths: widths,
    });
  }
  return sections;
}

/**
 * Pull section background color from the nearest ancestor with an inline
 * background-color; defaults to white. Section padding stays 0 because
 * Klaviyo rows don't wrap with outer padding.
 */
function extractRowContext(
  _$: $,
  $columns: cheerio.Cheerio<El>,
): { sectionColor: string } {
  let sectionColor = "#ffffff";
  let $cur: cheerio.Cheerio<El> = $columns.first().parent();
  for (let i = 0; i < 6 && $cur.length > 0; i++) {
    const s = parseInlineStyles($cur.attr("style"));
    const bg = s["background-color"] || s["background"];
    if (bg && bg !== "transparent") {
      sectionColor = bg;
      break;
    }
    $cur = $cur.parent();
  }
  return { sectionColor };
}

/**
 * Parse a kl-split block into a 2-column layout.
 */
export function parseSplitBlock(
  $: $,
  $td: cheerio.Cheerio<El>,
  warnings: string[],
): ColumnBlock | null {
  const $subblocks = findCls($td, "kl-split-subblock");
  const $left = $subblocks.first();
  const $right = $subblocks.last();
  if ($left.length === 0 || $right.length === 0) return null;

  const leftStyle = parseInlineStyles($left.attr("style"));
  const rightStyle = parseInlineStyles($right.attr("style"));
  const leftWidth = parseFloat(leftStyle["width"] || "50");
  const rightWidth = parseFloat(rightStyle["width"] || "50");

  let alignment = VerticalAlignment.TOP;
  const valign = (leftStyle["vertical-align"] || "").toLowerCase();
  if (valign === "middle" || valign === "center") alignment = VerticalAlignment.CENTER;
  else if (valign === "bottom") alignment = VerticalAlignment.BOTTOM;

  const leftBlock = parseSplitSubblock($, $left, warnings);
  const rightBlock = parseSplitSubblock($, $right, warnings);

  // Section color from the outer wrapping td (kl-split's parent chain)
  let sectionColor = "#ffffff";
  let $cur: cheerio.Cheerio<El> = $td;
  for (let i = 0; i < 6 && $cur.length > 0; i++) {
    const s = parseInlineStyles($cur.attr("style"));
    const bg = s["background-color"] || s["background"];
    if (bg && bg !== "transparent") {
      sectionColor = bg;
      break;
    }
    $cur = $cur.parent();
  }

  return {
    type: EmailBlockType.COLUMN,
    blockId: nextId(),
    sectionPadding: { top: 0, right: 0, bottom: 0, left: 0 },
    sectionColor,
    columns: [leftBlock, rightBlock],
    columnCount: 2,
    gap: 0,
    stackOnMobile: true,
    alignment,
    columnWidths: [leftWidth, rightWidth],
  };
}

/**
 * Extract the primary content of a kl-split subblock into a single nestable block.
 * Priority: button > image > text. Images without src return null (placeholder).
 */
function parseSplitSubblock(
  $: $,
  $subblock: cheerio.Cheerio<El>,
  _warnings: string[],
): NonRecursiveBlock | null {
  const subblockPadding = parsePaddingFromSpacer($subblock);

  // Button
  const $button = findCls($subblock, "kl-button").first();
  if ($button.length > 0) {
    const $a = $button.find("a").first();
    if ($a.length > 0) {
      const aStyle = parseInlineStyles($a.attr("style"));
      const buttonTdStyle = parseInlineStyles($a.parent("td").attr("style"));
      const padding = parsePadding(aStyle);
      return {
        type: EmailBlockType.BUTTON,
        blockId: nextId(),
        sectionPadding: { top: 0, right: 0, bottom: 0, left: 0 },
        sectionColor: "#ffffff",
        alignment: ("center" as ButtonBlock["alignment"]),
        cornerRadius: 0,
        buttonText: $a.text().trim(),
        padding,
        buttonLink: $a.attr("href"),
        fillColor:
          buttonTdStyle["background-color"] ||
          aStyle["background-color"] ||
          "#000000",
        strokeColor: aStyle["border-color"] || "#000000",
        textColor: parseColor(aStyle["color"]),
        strokeWeight: 0,
        fontFamily: parseFontFamily(aStyle["font-family"]),
        fontSize: parseFontSize(aStyle["font-size"]),
        linkType: "web-page" as ButtonBlock["linkType"],
      } satisfies ButtonBlock;
    }
  }

  // Image (only if src present)
  const $img = $subblock.find("img").first();
  if ($img.length > 0 && $img.attr("src")) {
    const $link = $img.closest("a");
    return {
      type: EmailBlockType.IMAGE,
      blockId: nextId(),
      sectionPadding: { top: 0, right: 0, bottom: 0, left: 0 },
      sectionColor: "#ffffff",
      imageUrl: $img.attr("src") || "",
      altText: $img.attr("alt") || undefined,
      clickthroughUrl: $link.length > 0 ? $link.attr("href") : undefined,
      padding: subblockPadding,
      showCaption: false,
    } satisfies ImageBlock;
  }

  // Text (div or raw text)
  const $textDiv = $subblock.find("div[style]").first();
  const divStyle = parseInlineStyles($textDiv.attr("style"));
  const text = ($textDiv.html() || $subblock.text()).trim();
  if (!text) return null;

  return {
    type: EmailBlockType.TEXT,
    blockId: nextId(),
    sectionPadding: { top: 0, right: 0, bottom: 0, left: 0 },
    sectionColor: "#ffffff",
    text: text.includes("<p") ? text : `<p>${text}</p>`,
    textColor: parseColor(divStyle["color"]),
    fontSize: parseFontSize(divStyle["font-size"]),
    fontFamily: parseFontFamily(divStyle["font-family"]),
    linkColor: parseColor(divStyle["color"]),
  } satisfies TextBlock;
}

function parsePaddingFromSpacer(
  $subblock: cheerio.Cheerio<El>,
): { top: number; right: number; bottom: number; left: number } {
  const $spacer = $subblock.find("td.spacer").first();
  if ($spacer.length > 0) {
    return parsePadding(parseInlineStyles($spacer.attr("style")));
  }
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

import type {
  ButtonBlock,
  ColumnBlock,
  DiscountBlock,
  ImageBlock,
  NonRecursiveBlock,
  Section,
  TextBlock,
} from "../../renderer/types.js";
import {
  Alignment,
  EmailBlockType,
  Size,
  VerticalAlignment,
} from "../../renderer/types.js";
import {
  parseColor,
  parseFontFamily,
  parseFontSize,
  parseInlineStyles,
  parsePadding,
} from "../style-utils.js";
import { type $, type El, findCls, hasClass, nextId } from "../helpers.js";
import type { ParseContext } from "../index.js";
import type * as cheerio from "cheerio";

const NESTABLE_TYPES = new Set<EmailBlockType>([
  EmailBlockType.TEXT,
  EmailBlockType.IMAGE,
  EmailBlockType.BUTTON,
  EmailBlockType.DISCOUNT,
]);

// Klaviyo columns frequently carry decorative "filler" blocks alongside the
// real content (a divider between a pair of images, a spacer between an image
// and a CTA). These aren't nestable in a Redo ColumnBlock but dropping them
// preserves the column layout the merchant designed — the alternative was a
// full-row flatten, which loses the grid entirely. Kept blocks are handled
// normally; truly incompatible content (HEADER/MENU/SOCIALS/PRODUCT/COLUMN)
// still triggers the bail-out below.
// ──────────────────────────────────────────────────────────────────
// DO NOT add HEADER/MENU/SOCIALS/PRODUCT to this set without first
// confirming those blocks really are decoratively-safe to drop. The
// whole point of keeping them in the bail path is that losing them
// silently is worse than losing the grid (they carry real content —
// logos, navigation, social links). SPACER and LINE are the only
// block types that are purely visual padding/separators.
const DROPPABLE_NON_NESTABLE: Set<EmailBlockType> = new Set<EmailBlockType>([
  EmailBlockType.SPACER,
  EmailBlockType.LINE,
]);

// Alignment-carrying block types — when we hoist one of these out of a
// column cell via the bail-out paths below, we force alignment to CENTER.
// ──────────────────────────────────────────────────────────────────
// DO NOT drop this override. When a block (e.g. socials, a menu, a
// narrow button) was designed to sit inside a column cell, its source
// alignment refers to the cell's local frame — "left" meant left
// within the cell, "right" meant right within the cell. Hoisting to
// a full-width section without re-centering makes those blocks
// visually stick to the email edge (symptom: footer socials jammed
// to the right margin after an image + socials row bail-out).
// CENTER is the safe default because the original content was
// narrower than the email width.
const ALIGNMENT_BEARING_TYPES: Set<EmailBlockType> = new Set<EmailBlockType>([
  EmailBlockType.BUTTON,
  EmailBlockType.MENU,
  EmailBlockType.SOCIALS,
  EmailBlockType.DISCOUNT,
]);

function recenterHoisted<S extends Section>(block: S): S {
  if (ALIGNMENT_BEARING_TYPES.has(block.type)) {
    return { ...block, alignment: Alignment.CENTER };
  }
  return block;
}

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
 * - SPACER and LINE blocks inside a column are dropped (decorative filler);
 *   the layout is preserved.
 * - HEADER/MENU/SOCIALS still trigger a full-row flatten since they carry
 *   real content and losing them silently would be worse than losing the grid.
 */
export function parseColumnRow(
  $: $,
  $columns: cheerio.Cheerio<El>,
  ctx: ParseContext,
  parseColumnContent: ($: $, $col: cheerio.Cheerio<El>, ctx: ParseContext) => Section[],
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

    perColumnBlocks.push(parseColumnContent($, $col, ctx));
  });

  // Drop decorative non-nestable filler (spacers, dividers) that would
  // otherwise trigger a flatten. We track how many got dropped per column so
  // we can surface a warning when the layout actually loses content.
  let droppedCount = 0;
  const cleanedPerColumnBlocks: Section[][] = perColumnBlocks.map((arr) => {
    const kept: Section[] = [];
    for (const b of arr) {
      if (
        !NESTABLE_TYPES.has(b.type) &&
        DROPPABLE_NON_NESTABLE.has(b.type)
      ) {
        droppedCount++;
        continue;
      }
      kept.push(b);
    }
    return kept;
  });
  if (droppedCount > 0) {
    ctx.warnings.push(
      `Dropped ${droppedCount} decorative block(s) (spacers/dividers) inside a ${$columns.length}-column row to preserve column structure.`,
    );
  }

  // Bail condition: any column still contains a block that can't live in a
  // Redo column (product, header, menu, socials, or a nested column row). We
  // emit everything flat so nothing gets silently lost.
  const hasNonNestable = cleanedPerColumnBlocks.some((arr) =>
    arr.some((b) => !NESTABLE_TYPES.has(b.type)),
  );
  if (hasNonNestable) {
    ctx.warnings.push(
      `Column row contains a non-nestable block (product or complex layout) — emitting contents as standalone sections.`,
    );
    return cleanedPerColumnBlocks.flat().map(recenterHoisted);
  }

  // Bail when zippering would produce >1 stacked ColumnBlock. Redo's
  // ColumnBlock stacks each row as its own full-width section on mobile,
  // which breaks the per-column reading order Klaviyo gives you. Emit the
  // contents flat with a warning so the importer can review post-import.
  const nestablePerColumn: NonRecursiveBlock[][] = cleanedPerColumnBlocks.map(
    (arr) =>
      arr.filter((b): b is NonRecursiveBlock => NESTABLE_TYPES.has(b.type)),
  );
  const wouldStack = nestablePerColumn.some((a) => a.length > 1);
  if (wouldStack) {
    ctx.warnings.push(
      `Multi-column row has stacked content per column — emitting contents flat (mobile reflow won't preserve column-by-column order). Review post-import.`,
    );
    return cleanedPerColumnBlocks.flat().map(recenterHoisted);
  }

  const $row = $columns.first().parent();
  const stackOnMobile = hasClass($row, "colstack") || $row.hasClass("colstack");
  const { sectionColor } = extractRowContext($, $columns);

  const rowCount = Math.max(1, ...nestablePerColumn.map((a) => a.length));

  const sections: ColumnBlock[] = [];
  for (let r = 0; r < rowCount; r++) {
    const isFirstRow = r === 0;
    const isLastRow = r === rowCount - 1;
    const cols = nestablePerColumn.map((arr) => {
      const block = arr[r];
      if (!block) return null;
      // ───────────────────────────────────────────────────────────────
      // DO NOT pass through `sectionPadding.left` / `right` here.
      // ───────────────────────────────────────────────────────────────
      // A nested block sits inside a ColumnBlock slot; horizontal
      // position is owned by the column's `columnWidths`. Standalone
      // block parsers (see `parseImageBlock` at `blocks/image.ts` —
      // "constrained-width images" / `containerTdWidth` branch) inflate
      // their own `sectionPadding.l/r` to center narrow content in a
      // full-width email — which is correct for a top-level block but
      // produces a narrow band inside a column slot (symptom: images
      // rendering ~200px wide with huge side margins inside a 3-col
      // row). Any future rewrite that preserves L/R padding when
      // building `cols` must also disable the narrow-image centering in
      // the child parsers — otherwise that bug reappears. Top/bottom
      // are clamped to keep zippered stacks touching.
      return {
        ...block,
        sectionPadding: {
          top: isFirstRow ? block.sectionPadding.top : 0,
          right: 0,
          bottom: isLastRow ? block.sectionPadding.bottom : 0,
          left: 0,
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
  ctx: ParseContext,
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

  const leftBlock = parseSplitSubblock($, $left, ctx);
  const rightBlock = parseSplitSubblock($, $right, ctx);

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
  _ctx: ParseContext,
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
      horizontalPadding: Size.CUSTOM,
      verticalPadding: Size.CUSTOM,
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

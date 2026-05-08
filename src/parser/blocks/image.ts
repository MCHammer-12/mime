import type { ImageBlock } from "../../renderer/types.js";
import { EmailBlockType, EMAIL_MAX_WIDTH_PX, Size } from "../../renderer/types.js";
import { findAncestorBackgroundColor, parseInlineStyles, parsePadding, parsePx } from "../style-utils.js";
import { type $, type El, nextId, sel } from "../helpers.js";
import { classifyKlaviyoUrl } from "../url-mapping.js";
import type { ParseContext } from "../index.js";
import type * as cheerio from "cheerio";

export function parseImageBlock(
  $: $,
  $td: cheerio.Cheerio<El>,
  $wrapper: cheerio.Cheerio<El>,
  ctx: ParseContext,
): ImageBlock | null {
  const $img = $td.find("img").first();
  if ($img.length === 0) return null;

  const src = $img.attr("src") || "";
  const alt = $img.attr("alt") || "";
  if (!src) {
    ctx.warnings.push(
      `Image placeholder (no src) — emitting empty Image block for merchant to fill`,
    );
  }
  const $link = $td.find(sel("kl-img-link")).first();
  const clickthrough = $link.length > 0 ? $link.attr("href") || "" : undefined;
  const mappedLink = clickthrough
    ? classifyKlaviyoUrl(clickthrough, EmailBlockType.IMAGE, ctx)
    : null;

  // Inner padding: prefer kl-img-base-auto-width, fall back to direct img container td
  let $paddingTd = $td.find(sel("kl-img-base-auto-width")).first();
  if ($paddingTd.length === 0) {
    $paddingTd = $td.find("td").has("img").first();
    if ($paddingTd.length === 0) $paddingTd = $td;
  }
  const paddingStyle = parseInlineStyles($paddingTd.attr("style"));
  const padding = parsePadding(paddingStyle);

  // Section-level padding and color from the component-wrapper's outer td
  const $outerTd = $wrapper.find("td").first();
  const outerStyle = parseInlineStyles($outerTd.attr("style"));
  const wrapperStyle = parseInlineStyles($wrapper.attr("style"));
  const sectionPadding = parsePadding(outerStyle);

  // Detect constrained-width images: if the image container td has an
  // explicit width smaller than the available area, size the outer section so
  // the image renders at the constrained width (e.g. a 126px logo centered).
  //
  // Redo's image renderer sets `<img width=100% />` and uses `sectionPadding`
  // to size the outer MjmlSection — so shrinking the image means widening
  // `sectionPadding.left/right`. The inner `padding` field is not applied
  // to image width, only to inner spacing in the builder UI.
  //
  // ──────────────────────────────────────────────────────────────────
  // INTERACTION NOTE (keep in sync with `blocks/column.ts`)
  // ──────────────────────────────────────────────────────────────────
  // This branch assumes the emitted block is TOP-LEVEL. When the caller
  // nests this block inside a ColumnBlock slot (see `parseColumnRow` in
  // `blocks/column.ts`), the column owns horizontal layout, and
  // `parseColumnRow` intentionally zeros L/R `sectionPadding` on each
  // nested block to undo the centering below. If you ever refactor
  // this function to accept a `nested: boolean` context flag, skip the
  // centering when nested — and keep column.ts's zero-out as a
  // belt-and-braces guard unless you've also stopped calling this
  // parser for nested images.
  const containerTdWidth = parsePx(paddingStyle["width"]);
  const availableWidth =
    EMAIL_MAX_WIDTH_PX - sectionPadding.left - sectionPadding.right;
  if (containerTdWidth && containerTdWidth < availableWidth) {
    const hPad = Math.floor((EMAIL_MAX_WIDTH_PX - containerTdWidth) / 2);
    sectionPadding.left = hPad;
    sectionPadding.right = hPad;
  }

  // mappedLink only ever returns web-page links now (see url-mapping.ts);
  // checkout-URL variables get rewritten to <storeUrl>/cart up there.
  const linkFields: Pick<
    ImageBlock,
    "clickthroughUrl" | "clickthroughLinkType" | "clickthroughSchemaFieldName"
  > = { clickthroughUrl: mappedLink?.buttonLink ?? clickthrough };

  return {
    type: EmailBlockType.IMAGE,
    blockId: nextId(),
    sectionPadding,
    sectionColor:
      outerStyle["background-color"] ||
      wrapperStyle["background-color"] ||
      findAncestorBackgroundColor($outerTd.length ? $outerTd : $wrapper) ||
      "#ffffff",
    imageUrl: src,
    altText: alt || undefined,
    ...linkFields,
    padding,
    horizontalPadding: Size.CUSTOM,
    verticalPadding: Size.CUSTOM,
    showCaption: false,
  };
}

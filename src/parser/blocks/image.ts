import type { ImageBlock } from "../../renderer/types.js";
import { EmailBlockType, EMAIL_MAX_WIDTH_PX, Size } from "../../renderer/types.js";
import { parseInlineStyles, parsePadding, parsePx } from "../style-utils.js";
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
  if (clickthrough) classifyKlaviyoUrl(clickthrough, EmailBlockType.IMAGE, ctx);

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

  // Detect constrained-width images: if the image container td has an explicit
  // width smaller than the available area, compute centering padding.
  const containerTdWidth = parsePx(paddingStyle["width"]);
  const availableWidth =
    EMAIL_MAX_WIDTH_PX - sectionPadding.left - sectionPadding.right;
  if (containerTdWidth && containerTdWidth < availableWidth) {
    const hPad = Math.floor((availableWidth - containerTdWidth) / 2);
    padding.left = hPad;
    padding.right = hPad;
  }

  return {
    type: EmailBlockType.IMAGE,
    blockId: nextId(),
    sectionPadding,
    sectionColor:
      outerStyle["background-color"] ||
      wrapperStyle["background-color"] ||
      "#ffffff",
    imageUrl: src,
    altText: alt || undefined,
    clickthroughUrl: clickthrough,
    padding,
    horizontalPadding: Size.CUSTOM,
    verticalPadding: Size.CUSTOM,
    showCaption: false,
  };
}

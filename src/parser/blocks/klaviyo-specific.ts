/**
 * Klaviyo-only blocks: video, preview quote (review), and drop shadow.
 * None of these have a Redo equivalent.
 *
 * Video + preview quote: skip entirely, push to ctx.skippedBlocks.
 * Drop shadow: if bodyBackgroundColor is white, emit an Image block pointing
 *   to the pre-made drop shadow asset; otherwise skip via ctx.skippedBlocks.
 *
 * Returning null from tryParseKlaviyoSpecific means "not a klaviyo-specific
 * block" — the dispatcher should continue checking other block types.
 * Returning an array (possibly empty) means "matched; consume this wrapper".
 */

import type * as cheerio from "cheerio";
import type { ImageBlock, Section } from "../../renderer/types.js";
import { EmailBlockType } from "../../renderer/types.js";
import { parseInlineStyles, parsePadding } from "../style-utils.js";
import { type $, type El, nextId, sel } from "../helpers.js";
import type { ParseContext } from "../index.js";

const DROP_SHADOW_LOCAL_PATH = "pics/drop-shadow.png";
// TODO-SHARED: upload pics/drop-shadow.png to Redo CDN and replace this path
// with the CDN URL before running migrations against prod templates.

export function tryParseKlaviyoSpecific(
  $: $,
  $wrapper: cheerio.Cheerio<El>,
  ctx: ParseContext,
  bodyBackgroundColor: string,
): Section[] | null {
  if (isVideoBlock($wrapper)) {
    ctx.skippedBlocks.push({
      blockType: "video",
      reason: "Klaviyo video block — not supported in Redo",
    });
    return [];
  }

  if (isPreviewQuoteBlock($, $wrapper)) {
    ctx.skippedBlocks.push({
      blockType: "preview-quote",
      reason: "Klaviyo preview quote (review) block — not supported in Redo",
    });
    return [];
  }

  const $shadowImg = findDropShadowImg($, $wrapper);
  if ($shadowImg.length > 0) {
    if (!isWhiteBackground(bodyBackgroundColor)) {
      ctx.skippedBlocks.push({
        blockType: "drop-shadow",
        reason: `body background is ${bodyBackgroundColor}, drop shadow only works on white`,
      });
      return [];
    }
    return [buildDropShadowImageBlock($wrapper)];
  }

  return null;
}

function isVideoBlock($wrapper: cheerio.Cheerio<El>): boolean {
  return $wrapper.find(sel("kl-video")).length > 0;
}

function isPreviewQuoteBlock(
  _$: $,
  $wrapper: cheerio.Cheerio<El>,
): boolean {
  if ($wrapper.find(sel("kl-review-gutter")).length > 0) return true;
  const wrapperClass = $wrapper.attr("class") || "";
  return /\b(gxp-)?kl-review-/.test(wrapperClass);
}

function findDropShadowImg(
  _$: $,
  $wrapper: cheerio.Cheerio<El>,
): cheerio.Cheerio<El> {
  return $wrapper.find('img[src*="bottom_shadow_"]');
}

function isWhiteBackground(color: string): boolean {
  const c = color.trim().toLowerCase().replace(/\s+/g, "");
  if (c === "#fff" || c === "#ffffff" || c === "white") return true;
  if (c === "rgb(255,255,255)" || c === "rgba(255,255,255,1)") return true;
  return false;
}

function buildDropShadowImageBlock(
  $wrapper: cheerio.Cheerio<El>,
): ImageBlock {
  const $outerTd = $wrapper.find("td").first();
  const outerStyle = parseInlineStyles($outerTd.attr("style"));
  const wrapperStyle = parseInlineStyles($wrapper.attr("style"));
  const sectionPadding = parsePadding(outerStyle);

  return {
    type: EmailBlockType.IMAGE,
    blockId: nextId(),
    sectionPadding,
    sectionColor:
      outerStyle["background-color"] ||
      wrapperStyle["background-color"] ||
      "#ffffff",
    imageUrl: DROP_SHADOW_LOCAL_PATH,
    altText: "Shadow",
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    showCaption: false,
  };
}

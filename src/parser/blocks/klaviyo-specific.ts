/**
 * Klaviyo-only blocks: video, preview quote (review), and drop shadow.
 *
 * Video: structurally a thumbnail <img> wrapped in an <a class="kl-img-link">
 *   clickthrough — exactly what Redo's Image block supports. So we route it
 *   through parseImageBlock (thumbnail src → imageUrl, video href →
 *   clickthroughUrl) rather than dropping it. A video with no thumbnail img
 *   has nothing to emit, so that case still skips via ctx.skippedBlocks.
 * Preview quote: skip entirely, push to ctx.skippedBlocks.
 * Drop shadow: if bodyBackgroundColor is white, emit an Image block pointing
 *   to the pre-made drop shadow asset; otherwise skip via ctx.skippedBlocks.
 *
 * Returning null from tryParseKlaviyoSpecific means "not a klaviyo-specific
 * block" — the dispatcher should continue checking other block types.
 * Returning an array (possibly empty) means "matched; consume this wrapper".
 */

import type * as cheerio from "cheerio";
import type { ImageBlock, Section } from "../../renderer/types.js";
import { EmailBlockType, Size } from "../../renderer/types.js";
import { findAncestorBackgroundColor, parseInlineStyles, parsePadding } from "../style-utils.js";
import { type $, type El, findCls, nextId, sel } from "../helpers.js";
import { parseImageBlock } from "./image.js";
import type { ParseContext } from "../index.js";

// On Replit, set `DROP_SHADOW_URL` in Secrets to the deployed static asset URL
// (e.g. `https://<subdomain>.replit.app/drop-shadow.png`). The PNG itself lives
// at `pics/drop-shadow.png` and gets bundled into the Replit deploy.
// See TODO-SHARED-klaviyo-specific.md Priority 0.
const DROP_SHADOW_URL =
  process.env.DROP_SHADOW_URL ??
  "https://PLACEHOLDER.replit.app/drop-shadow.png";

export function tryParseKlaviyoSpecific(
  $: $,
  $wrapper: cheerio.Cheerio<El>,
  ctx: ParseContext,
  bodyBackgroundColor: string,
): Section[] | null {
  if (isVideoBlock($wrapper)) {
    const $videoTd = findCls($wrapper, "kl-video").first();
    const hasThumb = $videoTd.find("img").first().attr("src");
    const hasLink = $videoTd.find(sel("kl-img-link")).first().attr("href");
    if (hasThumb && hasLink) {
      // A Klaviyo video is a thumbnail <img> inside an <a class="kl-img-link">
      // clickthrough — structurally an image-with-clickthrough. Route it to the
      // image parser: thumbnail → imageUrl, video href → clickthroughUrl. The
      // external video URL (e.g. youtu.be) passes through as a web-page link.
      const block = parseImageBlock($, $videoTd, $wrapper, ctx);
      if (block) {
        ctx.warnings.push(
          "Klaviyo video block → static thumbnail Image with the video URL as " +
            "clickthrough (no play affordance) — merchant may want to review",
        );
        return [block];
      }
    }
    // No thumbnail/link to convert — nothing to emit, so skip as before.
    ctx.skippedBlocks.push({
      blockType: "video",
      reason: "Klaviyo video block — no thumbnail image to convert",
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

  // Klaviyo "HTML" block (custom raw-HTML block — `<td class="kl-html">`).
  // Redo has no equivalent and the HTML payload is almost always
  // hand-written markup (tracking pixels, custom widgets, etc.) that we
  // can't safely re-emit as Redo blocks. Per merchant guidance: just
  // drop the block silently — the rest of the email still imports.
  // Tracked in skippedBlocks so it shows up in the warnings panel.
  if (isHtmlBlock($wrapper)) {
    ctx.skippedBlocks.push({
      blockType: "html",
      reason: "Klaviyo HTML block — removed (no equivalent in Redo)",
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

// Klaviyo's custom-HTML / "HTML" block. The block content lives inside
// a `<td class="kl-html">` (or `gxp-kl-html`) element — same naming
// pattern as kl-text, kl-image, etc. Match by descendant rather than the
// wrapper class itself since the wrapper carries the generic
// `component-wrapper` class.
function isHtmlBlock($wrapper: cheerio.Cheerio<El>): boolean {
  return $wrapper.find(sel("kl-html")).length > 0;
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
      findAncestorBackgroundColor($outerTd.length ? $outerTd : $wrapper) ||
      "#ffffff",
    imageUrl: DROP_SHADOW_URL,
    altText: "Shadow",
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    horizontalPadding: Size.CUSTOM,
    verticalPadding: Size.CUSTOM,
    showCaption: false,
  };
}

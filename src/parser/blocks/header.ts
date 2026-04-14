import type { ImageBlock, Section } from "../../renderer/types.js";
import { EmailBlockType, EMAIL_MAX_WIDTH_PX } from "../../renderer/types.js";
import { parseInlineStyles, parsePadding, parsePx } from "../style-utils.js";
import { type $, type El, findCls, nextId } from "../helpers.js";
import { classifyKlaviyoUrl } from "../url-mapping.js";
import type { ParseContext } from "../index.js";
import type * as cheerio from "cheerio";

/**
 * Klaviyo's "Header/Logo Bar" (hlb-wrapper) combines a logo image with optional
 * menu links. Redo's Header block auto-pulls the logo from the team's brand kit,
 * which isn't reliable for migrations. Instead, we convert the logo portion to
 * a plain Image block (menu items are handled separately by parseMenuFromHeader).
 */
export function parseHeaderBlock(
  $: $,
  $wrapper: cheerio.Cheerio<El>,
  ctx: ParseContext,
): Section[] {
  const blocks: Section[] = [];

  const $settingsTd = findCls($wrapper, "hlb-block-settings-content").first();
  const settingsStyle = parseInlineStyles($settingsTd.attr("style"));
  const sectionColor =
    settingsStyle["background-color"] ||
    settingsStyle["background"] ||
    "#ffffff";
  const sectionPadding = parsePadding(settingsStyle);

  // Logo → Image block
  const $logo = findCls($wrapper, "hlb-logo").first();
  if ($logo.length > 0) {
    const $logoImg = $logo.find("img").first();
    const $logoLink = $logo.find("a").first();
    const logoSrc = $logoImg.attr("src") || "";
    if (!logoSrc) return blocks;

    const logoWidth = parsePx($logoImg.attr("width")?.toString()) ?? 200;

    // Klaviyo renders the logo at its intrinsic width (e.g. 300px), centered
    // within the ~600px email. Redo's Image block is always full-width, so we
    // add horizontal inner padding to shrink the rendered image to match.
    const availableWidth = EMAIL_MAX_WIDTH_PX - sectionPadding.left - sectionPadding.right;
    const horizontalInnerPadding =
      logoWidth < availableWidth
        ? Math.floor((availableWidth - logoWidth) / 2)
        : 0;

    // Preserve any vertical padding on the logo TD (e.g. padding-bottom:10px).
    const logoTdStyle = parseInlineStyles($logo.attr("style"));
    const logoTdPadding = parsePadding(logoTdStyle);

    const logoHref = $logoLink.attr("href") || undefined;
    if (logoHref) classifyKlaviyoUrl(logoHref, EmailBlockType.IMAGE, ctx);

    blocks.push({
      type: EmailBlockType.IMAGE,
      blockId: nextId(),
      sectionPadding,
      sectionColor,
      imageUrl: logoSrc,
      padding: {
        top: logoTdPadding.top,
        right: horizontalInnerPadding,
        bottom: logoTdPadding.bottom,
        left: horizontalInnerPadding,
      },
      altText: $logoImg.attr("alt") || undefined,
      clickthroughUrl: logoHref,
    } satisfies ImageBlock);
  }

  return blocks;
}

import type { SocialItem, SocialsBlock } from "../../renderer/types.js";
import {
  Alignment,
  EmailBlockType,
  SocialIconColor,
  SocialPlatform,
} from "../../renderer/types.js";
import {
  detectSocialIconColor,
  detectSocialPlatform,
  findAncestorBackgroundColor,
  parseInlineStyles,
  parsePadding,
  parsePx,
  pickContrastingColor,
} from "../style-utils.js";
import { type $, type El, nextId } from "../helpers.js";
import { classifyKlaviyoUrl } from "../url-mapping.js";
import type { ParseContext } from "../index.js";
import type * as cheerio from "cheerio";

const DEFAULT_ICON_PADDING = 10;

export function parseSocialsBlock(
  $: $,
  $wrapper: cheerio.Cheerio<El>,
  ctx: ParseContext,
): SocialsBlock | null {
  const socialLinks: SocialItem[] = [];
  let detectedColor: string | null = null;
  let iconPadding: number | null = null;

  $wrapper.find("a").each((i, link) => {
    const $link = $(link);
    const href = $link.attr("href") || "";
    const platform = detectSocialPlatform(href);
    if (!platform) return;
    if (href) classifyKlaviyoUrl(href, EmailBlockType.SOCIALS, ctx);

    const $img = $link.find("img").first();
    if ($img.length > 0) {
      const c = detectSocialIconColor($img.attr("src") || "");
      if (detectedColor === null) {
        detectedColor = c;
      }
    }

    if (iconPadding === null) {
      const $parentDiv = $link.closest("div[style*='inline-block']");
      const parentStyle = parseInlineStyles($parentDiv.attr("style"));
      const px = parsePx(parentStyle["padding-right"]);
      if (px !== undefined) iconPadding = px;
    }

    socialLinks.push({
      id: `social-${i}`,
      platform: platform as SocialPlatform,
      url: href,
    });
  });

  if (socialLinks.length === 0) return null;

  const $td = $wrapper.find("td").first();
  const tdStyle = parseInlineStyles($td.attr("style"));
  const sectionColor =
    tdStyle["background-color"] ||
    findAncestorBackgroundColor($td.length ? $td : $wrapper) ||
    "#ffffff";

  const $alignDiv = $wrapper.find("div[style*='text-align']").first();
  const alignStyle = parseInlineStyles($alignDiv.attr("style"));
  const alignment = mapTextAlign(alignStyle["text-align"]);

  // Custom-uploaded icons have URLs that don't encode the variant color
  // (Klaviyo only encodes color in its stock /white/, /subtle/, /solid/
  // paths). For those, "original" is a guess that lands wrong on dark
  // backgrounds. Pick black/white based on section bg luminance instead.
  const iconColor =
    detectedColor === "original"
      ? pickContrastingColor(sectionColor, { dark: "black", light: "white" }) === "white"
        ? "white"
        : "black"
      : detectedColor;

  return {
    type: EmailBlockType.SOCIALS,
    blockId: nextId(),
    sectionPadding: parsePadding(tdStyle),
    sectionColor,
    socialLinks,
    iconColor: mapIconColor(iconColor),
    iconPadding: iconPadding ?? DEFAULT_ICON_PADDING,
    alignment,
  };
}

function mapIconColor(raw: string | null): SocialIconColor {
  // Prod SocialIconColor enum is black/white/gray only. Klaviyo /default/
  // colorful brand icons ("original") get mapped to BLACK since it's the
  // closest valid prod value for a solid-styled icon set.
  switch (raw) {
    case "white":
      return SocialIconColor.WHITE;
    case "gray":
      return SocialIconColor.GRAY;
    default:
      return SocialIconColor.BLACK;
  }
}

function mapTextAlign(value: string | undefined): Alignment {
  const v = (value || "").trim().toLowerCase();
  if (v === "left") return Alignment.LEFT;
  if (v === "right") return Alignment.RIGHT;
  return Alignment.CENTER;
}

import type { MenuBlock, Section } from "../../renderer/types.js";
import { Alignment, EmailBlockType } from "../../renderer/types.js";
import { parseColor, parseFontFamily, parseFontSize, parseInlineStyles, parsePadding } from "../style-utils.js";
import { type $, type El, findCls, nextId } from "../helpers.js";
import type { ParseContext } from "../index.js";
import type * as cheerio from "cheerio";

/**
 * Extract menu from a header/hlb-wrapper block.
 * Called by the dispatcher after parseHeaderBlock.
 */
export function parseMenuFromHeader(
  $: $,
  $wrapper: cheerio.Cheerio<El>,
  _ctx: ParseContext,
): MenuBlock | null {
  const $settingsTd = findCls($wrapper, "hlb-block-settings-content").first();
  const settingsStyle = parseInlineStyles($settingsTd.attr("style"));
  const sectionColor =
    settingsStyle["background-color"] ||
    settingsStyle["background"] ||
    "#ffffff";
  const settingsPadding = parsePadding(settingsStyle);

  const $navWrappers = findCls($wrapper, "kl-hlb-wrap");
  if ($navWrappers.length === 0) return null;

  const menuItems: { id: string; label: string }[] = [];
  const $firstLink = $navWrappers.first().find("a").first();
  $navWrappers.each((i, wrap) => {
    const $link = $(wrap).find("a").first();
    const label = $link.text().trim();
    if (!label) return;
    const href = $link.attr("href") || "#";
    const align = ($(wrap).attr("align") || "center").toLowerCase();
    const linkStyle = parseInlineStyles($link.attr("style"));
    const weightRaw = (linkStyle["font-weight"] || "").toLowerCase();
    const weightNum = parseInt(weightRaw, 10);
    const italic = (linkStyle["font-style"] || "").toLowerCase() === "italic";
    const underline = (linkStyle["text-decoration"] || "").toLowerCase().includes("underline");
    const isBold =
      weightRaw === "bold" || weightRaw === "bolder" || (!isNaN(weightNum) && weightNum >= 600);
    let inner = label;
    if (isBold) inner = `<strong>${inner}</strong>`;
    if (italic) inner = `<em>${inner}</em>`;
    if (underline) inner = `<u>${inner}</u>`;
    menuItems.push({
      id: `menu-${i}`,
      label: `<p style="text-align: ${align};"><a href="${href}" style="text-decoration:none">${inner}</a></p>`,
    });
  });

  if (menuItems.length === 0) return null;

  const firstLinkStyle = parseInlineStyles($firstLink.attr("style"));

  // When a sibling header image precedes the menu (shared hlb-block-settings-content
  // wrapper), the image block already took the top padding. Drop it here to avoid
  // doubling. Keep horizontal + bottom so the menu aligns with the header.
  const hasLogoSibling = findCls($wrapper, "hlb-logo").length > 0;
  const sectionPadding = {
    top: hasLogoSibling ? 0 : settingsPadding.top,
    right: settingsPadding.right,
    bottom: settingsPadding.bottom,
    left: settingsPadding.left,
  };

  const alignAttr = ($navWrappers.first().attr("align") || "center").toLowerCase();
  const alignment =
    alignAttr === "left"
      ? Alignment.LEFT
      : alignAttr === "right"
        ? Alignment.RIGHT
        : Alignment.CENTER;

  return {
    type: EmailBlockType.MENU,
    blockId: nextId(),
    sectionPadding,
    sectionColor,
    menuItems,
    linkColor: parseColor(firstLinkStyle["color"]),
    alignment,
    fontFamily: parseFontFamily(firstLinkStyle["font-family"]),
    fontSize: parseFontSize(firstLinkStyle["font-size"]),
    textColor: parseColor(firstLinkStyle["color"]),
    stackOnMobile: false,
  };
}

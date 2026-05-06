import type { SpacerBlock } from "../../renderer/types.js";
import { EmailBlockType } from "../../renderer/types.js";
import { findAncestorBackgroundColor, parseInlineStyles, parsePx } from "../style-utils.js";
import { type $, type El, nextId } from "../helpers.js";
import type { ParseContext } from "../index.js";
import type * as cheerio from "cheerio";

export function parseSpacerBlock(
  $: $,
  $wrapper: cheerio.Cheerio<El>,
  _ctx: ParseContext,
): SpacerBlock | null {
  const outerTd = $wrapper.find("td").first();
  const outerStyle = parseInlineStyles(outerTd.attr("style"));

  // Klaviyo renders spacers as <div style="height:Npx;line-height:Npx;">
  // inside an inner TD. The outer wrapper TD may also carry padding.
  const heightDiv = $wrapper.find("div[style*='height']").first();
  const divStyle = parseInlineStyles(heightDiv.attr("style"));
  const divHeight = parsePx(divStyle["height"]) ?? 0;

  const innerTd = heightDiv.parent("td");
  const innerStyle = parseInlineStyles(innerTd.attr("style"));

  const outerPadTop = parsePx(outerStyle["padding-top"]) ?? 0;
  const outerPadBottom = parsePx(outerStyle["padding-bottom"]) ?? 0;
  const innerPadTop = parsePx(innerStyle["padding-top"]) ?? 0;
  const innerPadBottom = parsePx(innerStyle["padding-bottom"]) ?? 0;

  const height =
    divHeight + outerPadTop + outerPadBottom + innerPadTop + innerPadBottom;
  if (height <= 0) return null;

  const sectionColor =
    innerStyle["background-color"] ||
    innerStyle["background"] ||
    outerStyle["background-color"] ||
    outerStyle["background"] ||
    findAncestorBackgroundColor(outerTd.length ? outerTd : $wrapper) ||
    "#ffffff";

  return {
    type: EmailBlockType.SPACER,
    blockId: nextId(),
    sectionPadding: { top: 0, right: 0, bottom: 0, left: 0 },
    sectionColor,
    height,
  };
}

import type { LineBlock } from "../../renderer/types.js";
import { EmailBlockType, Size } from "../../renderer/types.js";
import { parseBorderTop, parseInlineStyles, parsePadding } from "../style-utils.js";
import { type $, type El, nextId } from "../helpers.js";
import type { ParseContext } from "../index.js";
import type * as cheerio from "cheerio";

export function parseLineBlock(
  $: $,
  $p: cheerio.Cheerio<El>,
  $wrapper: cheerio.Cheerio<El>,
  _ctx: ParseContext,
): LineBlock | null {
  const border = parseBorderTop($p.attr("style"));
  if (!border) return null;

  const $outerTd = $wrapper.find("td").first();
  const outerStyle = parseInlineStyles($outerTd.attr("style"));

  const $innerTd = $p.parent("td");
  const innerStyle = parseInlineStyles($innerTd.attr("style"));
  const innerPadding = parsePadding(innerStyle);

  return {
    type: EmailBlockType.LINE,
    blockId: nextId(),
    sectionPadding: parsePadding(outerStyle),
    sectionColor: outerStyle["background-color"] || "#ffffff",
    color: border.color,
    padding: innerPadding,
    horizontalPadding: Size.CUSTOM,
    verticalPadding: Size.CUSTOM,
  };
}

import type { LineBlock } from "../../renderer/types.js";
import { EmailBlockType } from "../../renderer/types.js";
import { parseBorderTop, parseInlineStyles, parsePadding } from "../style-utils.js";
import { type $, type El, nextId } from "../helpers.js";
import type * as cheerio from "cheerio";

// thickness + innerPadding are renderer-only extras not in Redo's LineBlock Zod schema — stripped on API round-trip.
export type ParsedLineBlock = LineBlock & { thickness: number; innerPadding: { top: number; right: number; bottom: number; left: number } };

export function parseLineBlock(
  $: $,
  $p: cheerio.Cheerio<El>,
  $wrapper: cheerio.Cheerio<El>,
  _warnings: string[],
): ParsedLineBlock | null {
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
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    thickness: border.width,
    innerPadding,
  };
}

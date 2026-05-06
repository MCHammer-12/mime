import type { Section } from "../../renderer/types.js";
import { Alignment, ButtonLinkType, EmailBlockType } from "../../renderer/types.js";
import { findAncestorBackgroundColor, parseColor, parseFontFamily, parseFontSize, parseInlineStyles, parsePadding, parsePx } from "../style-utils.js";
import { type $, type El, nextId } from "../helpers.js";
import { classifyKlaviyoUrl } from "../url-mapping.js";
import type { ParseContext } from "../index.js";
import type * as cheerio from "cheerio";

export function parseButtonBlock(
  $: $,
  $td: cheerio.Cheerio<El>,
  ctx: ParseContext,
): Section | null {
  const $a = $td.find("a").first();
  const $bgTd = $td.find("td[bgcolor]").first();
  // Klaviyo placeholder buttons have no <a> — text + styling live on the inner <p>
  const isPlaceholder = $a.length === 0;
  const $textEl = isPlaceholder ? $bgTd.find("p").first() : $a;
  if (isPlaceholder && $textEl.length === 0) return null;
  if (isPlaceholder) {
    ctx.warnings.push(
      `Button placeholder (no link) — emitting empty Button block for merchant to fill`,
    );
  }

  const href = isPlaceholder ? "" : ($a.attr("href") || "");

  const aStyle = parseInlineStyles($textEl.attr("style"));
  const bgTdStyle = parseInlineStyles($bgTd.attr("style"));
  const bgColor =
    $bgTd.attr("bgcolor") ||
    bgTdStyle["background-color"] ||
    bgTdStyle["background"] ||
    aStyle["background-color"] ||
    aStyle["background"] ||
    "#000000";

  // The kl-button td sits inside a nested table; the outer wrapper td holds section padding/color
  const $outerTd = $td.closest("table").parent("td");
  const outerStyle = parseInlineStyles($outerTd.attr("style"));

  const align = ($td.attr("align") ||
    $bgTd.attr("align") ||
    "center") as Alignment;

  // Extract stroke from border styles on the bgTd
  const { strokeColor, strokeWeight } = parseBorderStroke(bgTdStyle);

  // Detect full-width: check if the inner table or a tag uses width:100%
  const $innerTable = $td.find("table").first();
  const innerTableStyle = parseInlineStyles($innerTable.attr("style"));
  const fullWidth =
    aStyle["width"] === "100%" ||
    innerTableStyle["width"] === "100%" ||
    $innerTable.attr("width") === "100%" ||
    false;

  const mapped = classifyKlaviyoUrl(href, EmailBlockType.BUTTON, ctx);
  const linkFields =
    mapped.linkType === "dynamic-variable"
      ? {
          linkType: ButtonLinkType.DYNAMIC_VARIABLE,
          schemaFieldName: mapped.schemaFieldName,
        }
      : {
          linkType: ButtonLinkType.WEB_PAGE,
          buttonLink: mapped.buttonLink,
        };

  return {
    type: EmailBlockType.BUTTON,
    blockId: nextId(),
    sectionPadding: parsePadding(outerStyle),
    sectionColor:
      outerStyle["background-color"] ||
      findAncestorBackgroundColor($outerTd.length ? $outerTd : $td) ||
      "#ffffff",
    buttonText: $textEl.text().trim(),
    fillColor: bgColor,
    textColor: parseColor(aStyle["color"]),
    strokeColor,
    strokeWeight,
    cornerRadius:
      parsePx(bgTdStyle["border-radius"] || aStyle["border-radius"]) ?? 0,
    fontSize: parseFontSize(aStyle["font-size"]),
    fontFamily: parseFontFamily(aStyle["font-family"]),
    alignment: align,
    padding: parsePadding(aStyle),
    fullWidth: fullWidth || undefined,
    ...linkFields,
  };
}

function parseBorderStroke(style: Record<string, string>): {
  strokeColor: string;
  strokeWeight: number;
} {
  // Check for explicit border shorthand first
  const border = style["border"];
  if (border && border !== "none") {
    const match = border.match(
      /(\d+(?:\.\d+)?)\s*px\s+(?:solid|dashed|dotted)\s+(#[0-9a-fA-F]{3,8}|\w+)/,
    );
    if (match) return { strokeWeight: parseFloat(match[1]), strokeColor: match[2] };
  }

  // Only extract as uniform stroke if ALL FOUR sides are set with matching values.
  // Klaviyo's common "button shadow" pattern is border-bottom only with a darker
  // color — that's NOT a stroke in Redo's model (Redo strokes are uniform), so
  // we drop it rather than paint a thick border all around the button.
  const sides = ["border-top", "border-right", "border-bottom", "border-left"] as const;
  const parsed = sides.map((side) => {
    const val = style[side];
    if (!val || val === "none") return null;
    const match = val.match(
      /(?:solid|dashed|dotted)\s+(\d+(?:\.\d+)?)\s*px\s+(#[0-9a-fA-F]{3,8}|\w+)/,
    );
    return match ? { weight: parseFloat(match[1]), color: match[2] } : null;
  });

  if (parsed.every((p) => p !== null)) {
    const [top, right, bottom, left] = parsed as { weight: number; color: string }[];
    const uniform =
      top.weight === right.weight &&
      right.weight === bottom.weight &&
      bottom.weight === left.weight &&
      top.color === right.color &&
      right.color === bottom.color &&
      bottom.color === left.color;
    if (uniform) {
      return { strokeWeight: top.weight, strokeColor: top.color };
    }
  }

  return { strokeColor: "transparent", strokeWeight: 0 };
}

/**
 * Deterministic Klaviyo HTML → Redo Section[] parser.
 *
 * Walks the Klaviyo DOM using kl-* classes (and gxp-kl-* variants)
 * and extracts structured email blocks without any LLM calls.
 *
 * Each block type's extraction logic lives in src/parser/blocks/<type>.ts.
 * This file is the dispatcher — it walks rows and delegates to block parsers.
 */

import * as cheerio from "cheerio";
import type { Section, SpacerBlock } from "../renderer/types.js";
import { EmailBlockType } from "../renderer/types.js";
import { parseInlineStyles, parsePx } from "./style-utils.js";
import { type $, type El, findCls, hasClass, resetBlockCounter, sel } from "./helpers.js";

// Block parsers
import { parseTextBlock } from "./blocks/text.js";
import { parseImageBlock } from "./blocks/image.js";
import { parseButtonBlock } from "./blocks/button.js";
import { parseHeaderBlock } from "./blocks/header.js";
import { parseMenuFromHeader } from "./blocks/menu.js";
import { parseLineBlock } from "./blocks/line.js";
import { parseSpacerBlock } from "./blocks/spacer.js";
import { parseSocialsBlock } from "./blocks/socials.js";
import { parseColumnRow, parseSplitBlock } from "./blocks/column.js";
import { parseProductBlock } from "./blocks/product.js";
import { tryParseDiscountFromText } from "./blocks/discount.js";
import { tryParseKlaviyoSpecific } from "./blocks/klaviyo-specific.js";

export interface ParseResult {
  sections: Section[];
  warnings: string[];
  bodyBackgroundColor: string;
}

export function parseKlaviyoHtml(html: string): ParseResult {
  resetBlockCounter();
  const $ = cheerio.load(html);
  const warnings: string[] = [];
  const sections: Section[] = [];

  // Extract body background color
  const $rootContainer = $(sel("root-container")).first();
  const rootStyle = parseInlineStyles($rootContainer.attr("style"));
  const bodyStyle = parseInlineStyles($("body").attr("style"));
  const bodyBackgroundColor =
    rootStyle["background-color"] ||
    bodyStyle["background-color"] ||
    "#ffffff";

  const boundParseColumnContent = (
    $: $,
    $col: cheerio.Cheerio<El>,
    w: string[],
  ) => parseColumnContent($, $col, w, bodyBackgroundColor);

  // Walk all kl-row elements in document order
  const rows = $(sel("kl-row"));

  rows.each((_, row) => {
    const $row = $(row);
    const $columns = $row.children(sel("kl-column"));

    if ($columns.length > 1) {
      const rowSections = parseColumnRow($, $columns, warnings, boundParseColumnContent);
      sections.push(...rowSections);
    } else if ($columns.length === 1) {
      const $col = $columns.first();
      const innerBlocks = boundParseColumnContent($, $col, warnings);
      sections.push(...innerBlocks);
    }
  });

  return { sections, warnings, bodyBackgroundColor };
}

// ─── Single column content extraction (dispatcher) ──────────────

function parseColumnContent(
  $: $,
  $col: cheerio.Cheerio<El>,
  warnings: string[],
  bodyBackgroundColor: string,
): Section[] {
  const blocks: Section[] = [];

  findCls($col, "component-wrapper").each((_, wrapper) => {
    const $wrapper = $(wrapper);

    // Klaviyo-only blocks (video, preview quote, drop shadow) — check
    // before kl-image matching so the drop-shadow img isn't treated as
    // a plain image block.
    const klaviyoSpecific = tryParseKlaviyoSpecific(
      $,
      $wrapper,
      warnings,
      bodyBackgroundColor,
    );
    if (klaviyoSpecific !== null) {
      blocks.push(...klaviyoSpecific);
      return;
    }

    // Header/Logo/Menu block
    if (hasClass($wrapper, "hlb-wrapper")) {
      const headerBlocks = parseHeaderBlock($, $wrapper, warnings);
      blocks.push(...headerBlocks);
      const menuBlock = parseMenuFromHeader($, $wrapper, warnings);
      if (menuBlock) blocks.push(menuBlock);
      return;
    }

    // Text block (or Discount split, when the kl-text holds special tokens)
    const $textTd = findCls($wrapper, "kl-text");
    if ($textTd.length > 0) {
      const $first = $textTd.first();
      const discountSplit = tryParseDiscountFromText($, $first, warnings);
      if (discountSplit) {
        blocks.push(...discountSplit);
        return;
      }
      const block = parseTextBlock($, $first, warnings);
      if (block) blocks.push(block);
      return;
    }

    // Image block
    const $imageTd = findCls($wrapper, "kl-image");
    if ($imageTd.length > 0) {
      const block = parseImageBlock($, $imageTd.first(), $wrapper, warnings);
      if (block) blocks.push(block);
      return;
    }

    // Button block
    const $buttonTd = findCls($wrapper, "kl-button");
    if ($buttonTd.length > 0) {
      const block = parseButtonBlock($, $buttonTd.first(), warnings);
      if (block) blocks.push(block);
      return;
    }

    // Split block
    const $splitTd = findCls($wrapper, "kl-split");
    if ($splitTd.length > 0) {
      const block = parseSplitBlock($, $splitTd.first(), warnings);
      if (block) blocks.push(block);
      return;
    }

    // Divider line
    const $dividerP = $wrapper.find("p[style*='border-top']");
    if ($dividerP.length > 0) {
      const block = parseLineBlock($, $dividerP.first(), $wrapper, warnings);
      if (block) blocks.push(block);
      return;
    }

    // Social icons
    const $socialImgs = $wrapper.find(
      "img[src*='d3k81ch9hvuctc.cloudfront.net/assets/email/buttons']",
    );
    if ($socialImgs.length > 0) {
      const block = parseSocialsBlock($, $wrapper, warnings);
      if (block) blocks.push(block);
      return;
    }

    // Product grid
    const $productGrid = findCls($wrapper, "kl-product");
    if ($productGrid.length > 0) {
      const block = parseProductBlock($, $productGrid.first(), warnings);
      if (block) blocks.push(block);
      return;
    }

    // Fallback: spacer (empty wrapper with padding)
    const text = $wrapper.text().trim();
    if (!text && $wrapper.find("img").length === 0) {
      const spacer = parseSpacerBlock($, $wrapper, warnings);
      if (spacer) blocks.push(spacer);
      return;
    }

    // Unknown block
    warnings.push(
      `Unknown block type in component-wrapper (text: "${text.slice(0, 60)}...")`,
    );
  });

  return blocks;
}

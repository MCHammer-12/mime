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
import type { Section } from "../renderer/types.js";
import { EmailBlockType } from "../renderer/types.js";
import { parseInlineStyles } from "./style-utils.js";
import { type $, type El, findCls, hasClass, resetBlockCounter, sel } from "./helpers.js";

// Block parsers
import { parseTextBlock } from "./blocks/text.js";
import { parseImageBlock } from "./blocks/image.js";
import { parseButtonBlock } from "./blocks/button.js";
import { parseHeaderLogoAsImage } from "./blocks/header.js";
import { parseMenuFromHeader } from "./blocks/menu.js";
import { parseLineBlock } from "./blocks/line.js";
import { parseSpacerBlock } from "./blocks/spacer.js";
import { parseSocialsBlock } from "./blocks/socials.js";
import { parseColumnRow, parseSplitBlock } from "./blocks/column.js";
import {
  parseProductBlock,
  parseLineItemsUcbBlock,
  parseBrowseAbandonmentCardBlock,
} from "./blocks/product.js";
import { tryParseDiscountFromText } from "./blocks/discount.js";
import { tryParseKlaviyoSpecific } from "./blocks/klaviyo-specific.js";

export interface UnsupportedFeature {
  blockType: EmailBlockType;
  reason: string;
  context: string;
}

export interface ReviewItem {
  blockType: EmailBlockType;
  variableName: string;
  context: string;
}

export interface SkippedBlock {
  blockType: "video" | "preview-quote" | "drop-shadow";
  reason: string;
}

export interface ParseContext {
  warnings: string[];
  unsupportedFeatures: UnsupportedFeature[];
  reviewItems: ReviewItem[];
  skippedBlocks: SkippedBlock[];
  /** Merchant's website URL (e.g. https://defiancebeauty.com), no trailing
   *  slash. Used by url-mapping to generate static /cart links — Redo's
   *  schemaInstance.checkoutUrl resolves to a Storefront cart URL that is
   *  silently null when the cart fetch fails (no Storefront token, etc.),
   *  and a hidden button is worse than a generic /cart link. Confirmed
   *  with Redo eng 2026-05-08. */
  storeUrl?: string | null;
}

export interface ParseResult extends ParseContext {
  sections: Section[];
  bodyBackgroundColor: string;
}

/** Strip trailing slashes; reject obviously-empty / non-http URLs. The
 *  url-mapping fallback only fires when this returns a non-empty string. */
function normalizeStoreUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

export function parseKlaviyoHtml(
  html: string,
  opts: { storeUrl?: string | null } = {},
): ParseResult {
  resetBlockCounter();
  const $ = cheerio.load(html);
  const ctx: ParseContext = {
    warnings: [],
    unsupportedFeatures: [],
    reviewItems: [],
    skippedBlocks: [],
    storeUrl: normalizeStoreUrl(opts.storeUrl),
  };
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
    c: ParseContext,
  ) => parseColumnContent($, $col, c, bodyBackgroundColor);

  // Walk all kl-row elements in document order
  const rows = $(sel("kl-row"));

  rows.each((_, row) => {
    const $row = $(row);
    const $columns = $row.children(sel("kl-column"));

    if ($columns.length > 1) {
      const rowSections = parseColumnRow($, $columns, ctx, boundParseColumnContent);
      sections.push(...rowSections);
    } else if ($columns.length === 1) {
      const $col = $columns.first();
      const innerBlocks = boundParseColumnContent($, $col, ctx);
      sections.push(...innerBlocks);
    }
  });

  const merged = mergeAdjacentProductBlocks(sections);

  return { sections: merged, ...ctx, bodyBackgroundColor };
}

/**
 * Merge ProductsBlocks of the same shape into a single block, even when
 * they're separated by purely-decorative sections (spacers, dividers).
 * Klaviyo merchants commonly stack multiple hand-picked product grids
 * vertically with small spacers / dividers between them; in Redo the
 * equivalent is one Products block whose row gap is built into the block
 * itself, so the intervening decorative sections become redundant.
 *
 * Merge criteria: both ProductsBlocks are `productSelectionType: "static"`
 * and have matching `columns`. Intervening sections must all be SPACER or
 * LINE — anything else (text, image, etc.) signals a logical break in the
 * merchant's grouping and breaks the merge. The intervening decorative
 * sections are dropped when a merge happens.
 *
 * Dynamic blocks are NOT merged — each carries its own `_pendingFilter` /
 * `schemaFieldName` and combining them would lose semantics.
 */
function mergeAdjacentProductBlocks(sections: Section[]): Section[] {
  const out: Section[] = [];
  for (const s of sections) {
    if (s.type !== EmailBlockType.PRODUCTS) {
      out.push(s);
      continue;
    }
    // Find the most recent ProductsBlock in `out`, walking back over only
    // SPACER / LINE sections. A non-decorative block (text, image, button,
    // column, etc.) breaks the chain.
    let prevIdx = out.length - 1;
    while (
      prevIdx >= 0 &&
      (out[prevIdx]!.type === EmailBlockType.SPACER ||
        out[prevIdx]!.type === EmailBlockType.LINE)
    ) {
      prevIdx--;
    }
    const prev = prevIdx >= 0 ? out[prevIdx] : undefined;
    if (
      prev &&
      prev.type === EmailBlockType.PRODUCTS &&
      (prev as any).productSelectionType === "static" &&
      (s as any).productSelectionType === "static" &&
      (prev as any).columns === (s as any).columns
    ) {
      const prevPending = (prev as any)._pendingProducts ?? [];
      const sPending = (s as any)._pendingProducts ?? [];
      // Dedupe by case-insensitive name. Klaviyo grids occasionally repeat
      // the same product across cells (responsive overflow slots, image-
      // row + title-row pairs), and the importer would otherwise resolve
      // the same product multiple times into manuallySelectedProducts.
      const seen = new Set<string>();
      const merged: { name: string }[] = [];
      for (const p of [...prevPending, ...sPending]) {
        const k = p.name.trim().toLowerCase();
        if (!k || seen.has(k)) continue;
        seen.add(k);
        merged.push(p);
      }
      (prev as any)._pendingProducts = merged;
      (prev as any).numberOfProducts = merged.length;
      // Drop any intervening decorative sections — they were Klaviyo's
      // visual gap between grid rows, redundant inside the merged block.
      out.length = prevIdx + 1;
      continue;
    }
    out.push(s);
  }
  return out;
}

// ─── Single column content extraction (dispatcher) ──────────────

function parseColumnContent(
  $: $,
  $col: cheerio.Cheerio<El>,
  ctx: ParseContext,
  bodyBackgroundColor: string,
): Section[] {
  const blocks: Section[] = [];

  findCls($col, "component-wrapper").each((_, wrapper) => {
    const $wrapper = $(wrapper);

    // Skip MJML mobile/desktop variants hidden via inline display:none.
    // Some Klaviyo templates (e.g. Charlie 1 Horse) ship paired
    // `desktop-only` + `mobile-only` wrappers per row; the off-client
    // variant carries `display:none` and a media query flips it at
    // render time. Parsing both yields a duplicate of every block.
    const wrapperStyle = ($wrapper.attr("style") || "")
      .replace(/\s/g, "")
      .toLowerCase();
    if (wrapperStyle.includes("display:none")) return;

    // Klaviyo-only blocks (video, preview quote, drop shadow) — check
    // before kl-image matching so the drop-shadow img isn't treated as
    // a plain image block.
    const klaviyoSpecific = tryParseKlaviyoSpecific(
      $,
      $wrapper,
      ctx,
      bodyBackgroundColor,
    );
    if (klaviyoSpecific !== null) {
      blocks.push(...klaviyoSpecific);
      return;
    }

    // Header/Logo/Menu block
    if (hasClass($wrapper, "hlb-wrapper")) {
      const headerBlocks = parseHeaderLogoAsImage($, $wrapper, ctx);
      blocks.push(...headerBlocks);
      const menuBlock = parseMenuFromHeader($, $wrapper, ctx);
      if (menuBlock) blocks.push(menuBlock);
      return;
    }

    // Text block (or Discount split, when the kl-text holds special tokens)
    const $textTd = findCls($wrapper, "kl-text");
    if ($textTd.length > 0) {
      const $first = $textTd.first();
      const discountSplit = tryParseDiscountFromText($, $first, ctx);
      if (discountSplit) {
        blocks.push(...discountSplit);
        return;
      }
      const block = parseTextBlock($, $first, ctx);
      if (block) blocks.push(block);
      return;
    }

    // Image block
    const $imageTd = findCls($wrapper, "kl-image");
    if ($imageTd.length > 0) {
      const block = parseImageBlock($, $imageTd.first(), $wrapper, ctx);
      if (block) blocks.push(block);
      return;
    }

    // Button block
    const $buttonTd = findCls($wrapper, "kl-button");
    if ($buttonTd.length > 0) {
      const block = parseButtonBlock($, $buttonTd.first(), ctx);
      if (block) blocks.push(block);
      return;
    }

    // Split block
    const $splitTd = findCls($wrapper, "kl-split");
    if ($splitTd.length > 0) {
      const block = parseSplitBlock($, $splitTd.first(), ctx);
      if (block) blocks.push(block);
      return;
    }

    // Divider line
    const $dividerP = $wrapper.find("p[style*='border-top']");
    if ($dividerP.length > 0) {
      const block = parseLineBlock($, $dividerP.first(), $wrapper, ctx);
      if (block) blocks.push(block);
      return;
    }

    // Social icons — match either Klaviyo-hosted stock icons OR wrappers
    // where ≥2 <a href> targets point to known social-network domains
    // (brands often upload custom-designed icons).
    const $socialImgs = $wrapper.find(
      "img[src*='d3k81ch9hvuctc.cloudfront.net/assets/email/buttons']",
    );
    const socialHrefCount = $wrapper
      .find("a[href]")
      .filter(
        (_, a) =>
          /(?:facebook|instagram|tiktok|twitter|x\.com|youtube|pinterest|linkedin|snapchat|threads|whatsapp)\.(?:com|net)/i.test(
            $(a).attr("href") || "",
          ),
      ).length;
    if ($socialImgs.length > 0 || socialHrefCount >= 2) {
      const block = parseSocialsBlock($, $wrapper, ctx);
      if (block) blocks.push(block);
      return;
    }

    // Product grid — Klaviyo sometimes ships multiple `kl-product` divs
    // inside a single component-wrapper (e.g. two product rows stacked).
    // Process each one separately so we don't silently drop later ones.
    // Static product blocks emit multiple sections (image row + title row).
    const $productGrid = findCls($wrapper, "kl-product");
    if ($productGrid.length > 0) {
      $productGrid.each((_, p) => {
        blocks.push(...parseProductBlock($, $(p), ctx));
      });
      return;
    }

    // Klaviyo universal content block: cart line_items loop. Must come
    // before the spacer fallback (wrapper has content, just not in a
    // shape any of the above parsers recognize).
    const lineItemsBlock = parseLineItemsUcbBlock($, $wrapper, ctx);
    if (lineItemsBlock) {
      blocks.push(lineItemsBlock);
      return;
    }

    // Browse-abandonment "product card": hand-built kl-table with inline
    // {{ event.Name }} / {{ event.ImageURL }} variables (no Liquid loop).
    // Best Sellers fallback until Redo's schema adds a viewed_products
    // recommendation type — see parseBrowseAbandonmentCardBlock for
    // context.
    const baCardBlock = parseBrowseAbandonmentCardBlock($, $wrapper, ctx);
    if (baCardBlock) {
      blocks.push(baCardBlock);
      return;
    }

    // Fallback: spacer (empty wrapper with padding)
    const text = $wrapper.text().trim();
    if (!text && $wrapper.find("img").length === 0) {
      const spacer = parseSpacerBlock($, $wrapper, ctx);
      if (spacer) blocks.push(spacer);
      return;
    }

    // Unknown block
    ctx.warnings.push(
      `Unknown block type in component-wrapper (text: "${text.slice(0, 60)}...")`,
    );
  });

  return blocks;
}

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
import { normalizeStyleAttrQuotes, parseInlineStyles } from "./style-utils.js";
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
import { parseColumnRow, parseSplitBlock, parseTableImageRow } from "./blocks/column.js";
import {
  parseProductBlock,
  parseLineItemsUcbBlock,
  parseBrowseAbandonmentCardBlock,
} from "./blocks/product.js";
import { parseCouponBlock, tryParseDiscountFromText } from "./blocks/discount.js";
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
  normalizeStyleAttrQuotes($);
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

  // Section/hero background images aren't representable in Redo: email sections
  // carry only a flat `sectionColor` (email-template.ts baseSectionSchema —
  // confirmed against origin/main 2026-06-16; no hero/overlay block exists).
  // Klaviyo sets hero backgrounds via a `background:url(...)` /
  // `background-image:url(...)` inline style, which we drop (keeping just the
  // color). Surface each dropped image URL — deduped — so the operator can
  // re-add it manually as an Image block instead of silently losing it.
  //
  // Scoped to Klaviyo media-library images (`.../company/<id>/images/...`) on
  // Klaviyo's CDN — the same host the socials parser keys on. A raw
  // `background:url()` match would fire on ~52% of templates (Liquid-dynamic
  // bgs, Outlook VML fallbacks, migration-tool decoration); the Klaviyo
  // merchant-image scope is the real "merchant uploaded a hero background"
  // signal (~2% of templates) with no observed false positives.
  const droppedBgImages = new Set<string>();
  $("[style]").each((_, el) => {
    const m = ($(el).attr("style") || "").match(
      /background(?:-image)?\s*:[^;]*url\(\s*['"]?([^'")\s]+)/i,
    );
    const url = m?.[1];
    if (
      !url ||
      !/d3k81ch9hvuctc\.cloudfront\.net\/company\/[^/]+\/images\//i.test(url) ||
      droppedBgImages.has(url)
    ) {
      return;
    }
    droppedBgImages.add(url);
    ctx.warnings.push(
      `Section background image not migrated — Redo email sections support only a flat background color, not a background image. Re-add it manually as an Image block in the editor: ${url}`,
    );
  });

  const boundParseColumnContent = (
    $: $,
    $col: cheerio.Cheerio<El>,
    c: ParseContext,
  ) => parseColumnContent($, $col, c, bodyBackgroundColor);

  // Walk kl-rows and any stray component-wrapper in document order. Klaviyo
  // usually nests every wrapper under kl-row > kl-column, but not always — a
  // wrapper hanging straight off a kl-section used to be walked by nothing and
  // its blocks disappeared without so much as a warning.
  const units = $(`${sel("kl-row")}, .component-wrapper`).filter(
    (_, e) => $(e).parent().closest(sel("kl-row")).length === 0,
  );

  units.each((_, unit) => {
    const $unit = $(unit);
    if (!$unit.is(sel("kl-row"))) {
      sections.push(...parseWrapper($, $unit, ctx, bodyBackgroundColor));
      return;
    }

    const $columns = $unit.children(sel("kl-column"));

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
    blocks.push(...parseWrapper($, $(wrapper), ctx, bodyBackgroundColor));
  });
  return blocks;
}

// One component-wrapper → the blocks it contains. Reached either through a
// kl-column (the normal case) or directly off a kl-section (Klaviyo emits that
// shape occasionally; before it was walked, those blocks vanished silently).
function parseWrapper(
  $: $,
  $wrapper: cheerio.Cheerio<El>,
  ctx: ParseContext,
  bodyBackgroundColor: string,
): Section[] {
  const blocks: Section[] = [];

  // Skip MJML mobile/desktop variants hidden via inline display:none.
  // Some Klaviyo templates (e.g. Charlie 1 Horse) ship paired
  // `desktop-only` + `mobile-only` wrappers per row; the off-client
  // variant carries `display:none` and a media query flips it at
  // render time. Parsing both yields a duplicate of every block.
  const wrapperStyle = ($wrapper.attr("style") || "")
    .replace(/\s/g, "")
    .toLowerCase();
  if (wrapperStyle.includes("display:none")) return blocks;

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
    return blocks;
  }

  // Header/Logo/Menu block
  if (hasClass($wrapper, "hlb-wrapper")) {
    const headerBlocks = parseHeaderLogoAsImage($, $wrapper, ctx);
    blocks.push(...headerBlocks);
    const menuBlock = parseMenuFromHeader($, $wrapper, ctx);
    if (menuBlock) blocks.push(menuBlock);
    return blocks;
  }

  // Text block (or Discount split, when the kl-text holds special tokens)
  const $textTd = findCls($wrapper, "kl-text");
  if ($textTd.length > 0) {
    const $first = $textTd.first();
    const discountSplit = tryParseDiscountFromText($, $first, ctx);
    if (discountSplit) {
      blocks.push(...discountSplit);
      return blocks;
    }
    const block = parseTextBlock($, $first, ctx);
    if (block) blocks.push(block);
    return blocks;
  }

  // Image block
  const $imageTd = findCls($wrapper, "kl-image");
  if ($imageTd.length > 0) {
    const block = parseImageBlock($, $imageTd.first(), $wrapper, ctx);
    if (block) blocks.push(block);
    return blocks;
  }

  // Coupon block — a bare {% coupon_code %} pill, no kl-text to split.
  const $couponTd = findCls($wrapper, "kl-coupon");
  if ($couponTd.length > 0) {
    const block = parseCouponBlock($, $couponTd.first(), ctx);
    if (block) blocks.push(block);
    return blocks;
  }

  // Button block
  const $buttonTd = findCls($wrapper, "kl-button");
  if ($buttonTd.length > 0) {
    const block = parseButtonBlock($, $buttonTd.first(), ctx);
    if (block) blocks.push(block);
    return blocks;
  }

  // Split block
  const $splitTd = findCls($wrapper, "kl-split");
  if ($splitTd.length > 0) {
    const block = parseSplitBlock($, $splitTd.first(), ctx);
    if (block) blocks.push(block);
    return blocks;
  }

  // Divider line
  const $dividerP = $wrapper.find("p[style*='border-top']");
  if ($dividerP.length > 0) {
    const block = parseLineBlock($, $dividerP.first(), $wrapper, ctx);
    if (block) blocks.push(block);
    return blocks;
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
    return blocks;
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
    return blocks;
  }

  // Klaviyo universal content block: cart line_items loop. Must come
  // before the spacer fallback (wrapper has content, just not in a
  // shape any of the above parsers recognize).
  const lineItemsBlock = parseLineItemsUcbBlock($, $wrapper, ctx);
  if (lineItemsBlock) {
    blocks.push(lineItemsBlock);
    return blocks;
  }

  // Browse-abandonment "product card": hand-built kl-table with inline
  // {{ event.Name }} / {{ event.ImageURL }} variables (no Liquid loop).
  // Best Sellers fallback until Redo's schema adds a viewed_products
  // recommendation type — see parseBrowseAbandonmentCardBlock for
  // context.
  const baCardBlock = parseBrowseAbandonmentCardBlock($, $wrapper, ctx);
  if (baCardBlock) {
    blocks.push(baCardBlock);
    return blocks;
  }

  // Trust-bar / badge row: a kl-table whose cells are images. Without this
  // it falls through to "Unknown block" below and every badge is dropped.
  const tableImageRow = parseTableImageRow($, $wrapper, ctx);
  if (tableImageRow) {
    blocks.push(tableImageRow);
    return blocks;
  }

  // Fallback: spacer (empty wrapper with padding)
  const text = $wrapper.text().trim();
  if (!text && $wrapper.find("img").length === 0) {
    const spacer = parseSpacerBlock($, $wrapper, ctx);
    if (spacer) blocks.push(spacer);
    return blocks;
  }

  // Unknown block
  ctx.warnings.push(
    `Unknown block type in component-wrapper (text: "${text.slice(0, 60)}...")`,
  );

  return blocks;
}

import type {
  ButtonBlock,
  ColumnBlock,
  ImageBlock,
  NonRecursiveBlock,
  Padding,
  Section,
} from "../../renderer/types.js";
import {
  Alignment,
  EmailBlockType,
  VerticalAlignment,
} from "../../renderer/types.js";
import {
  parseColor,
  parseFontFamily,
  parseFontSize,
  parseInlineStyles,
  parsePadding,
  parsePx,
} from "../style-utils.js";
import { type $, type El, nextId } from "../helpers.js";
import type * as cheerio from "cheerio";

// ─── Local type shims (TODO-SHARED-product.md) ──────────────────
//
// Redo's interactive-cart block + ProductFilter document aren't in
// src/renderer/types.ts yet. Defined locally and cast through Section
// on return. When types.ts is unfrozen, lift these into it.

export interface InlineButton {
  alignment: Alignment;
  cornerRadius: number;
  buttonText: string;
  padding: Padding;
  fillColor: string;
  strokeColor: string;
  textColor: string;
  strokeWeight: number;
  fontFamily: string;
  fontSize: number;
}

export type ProductImageSize = "small" | "medium" | "large";
export type ProductLayoutType = "rows" | "grid";
export type ProductObjectFit = "cover" | "contain";
export type ProductSelectionType = "dynamic" | "manual";

export interface ProductsBlock {
  type: "interactive-cart";
  blockId: string;
  sectionPadding: Padding;
  sectionColor: string;
  textColor: string;
  fontFamily: string;
  titleFontSize?: number;
  imageCornerRadius: number;
  checkoutButton: InlineButton;
  lineItemButtons: InlineButton;
  numberOfProducts: number;
  imageSize: ProductImageSize;
  productSelectionType: ProductSelectionType;
  showPrice?: boolean;
  showTitle?: boolean;
  showImage?: boolean;
  showButton?: boolean;
  showQuantity?: boolean;
  layoutType?: ProductLayoutType;
  alignment: Alignment;
  columns: number;
  stackOnMobile: boolean;
  manuallySelectedProducts: { productId: string; variantId: string }[];
  imageAspectRatio?: number;
  imageObjectFit?: ProductObjectFit;
  schemaFieldName?: string;
  provider: "shopify";

  // Non-prod field: the executor reads this, creates the filter via
  // createProductFilter, then replaces it with recommendedProductFilterId.
  _pendingFilter?: ProductFilterDoc;
  recommendedProductFilterId?: string;
}

export interface ProductFilterDoc {
  name: string;
  provider: "shopify";
  additionalProductFilters: {
    type: "inventory";
    inventory: number;
    comparisonOperator: "greater_than";
  }[];
  productRecommendationType:
    | "best_sellers"
    | "products_added_to_cart"
    | "collection";
  sortBy?: "price_desc" | "price_asc";
  unit?: "day";
  value?: number;
  collectionId?: string;
}

// ─── Filter defaults ───────────────────────────────────────────────

const BEST_SELLERS_FILTER: ProductFilterDoc = {
  name: "Best Sellers",
  provider: "shopify",
  additionalProductFilters: [
    { type: "inventory", inventory: 0, comparisonOperator: "greater_than" },
  ],
  productRecommendationType: "best_sellers",
};

const CART_ITEM_FILTER: ProductFilterDoc = {
  name: "Cart Item",
  provider: "shopify",
  additionalProductFilters: [
    { type: "inventory", inventory: 0, comparisonOperator: "greater_than" },
  ],
  productRecommendationType: "products_added_to_cart",
  sortBy: "price_desc",
  unit: "day",
  value: 90,
};

const CART_CONTEXT_LOOP_RE =
  /\{%\s*for\s+\w+\s+in\s+(event\.extra\.line_items|items)\s*%\}/;

const FEEDS_ITEM_RE = /\{%\s*(?:if|with)\s+[^%]*\bfeeds\.?\|index:\d+/;

// Cached per-document cart-context detection. parseProductBlock runs once per
// product block; cart signal lives in other blocks so we only need to scan the
// whole doc once per template.
const cartContextCache = new WeakMap<$, boolean>();

function detectCartContext($: $): boolean {
  const cached = cartContextCache.get($);
  if (cached !== undefined) return cached;
  const html = $.html();
  const hit = CART_CONTEXT_LOOP_RE.test(html);
  cartContextCache.set($, hit);
  return hit;
}

// ─── Entry point ───────────────────────────────────────────────────

export function parseProductBlock(
  $: $,
  $product: cheerio.Cheerio<El>,
  warnings: string[],
): Section | null {
  const $cells = $product.find(".kl-product-cell-stack, .gxp-kl-product-cell-stack");
  if ($cells.length === 0) return null;

  const isDynamic = $cells.toArray().some((cell) => {
    const txt = $(cell).text();
    return FEEDS_ITEM_RE.test(txt);
  });

  if (isDynamic) {
    return parseDynamicProductBlock($, $product, $cells, warnings);
  }
  return parseStaticProductBlock($, $cells, warnings);
}

// ─── Dynamic: interactive-cart block with pending filter ──────────

function parseDynamicProductBlock(
  $: $,
  $product: cheerio.Cheerio<El>,
  $cells: cheerio.Cheerio<El>,
  warnings: string[],
): Section {
  const firstCell = $cells.first();
  const cellText = firstCell.text();

  // Columns: width % on cell → columns count = round(100 / width)
  const firstCellStyle = parseInlineStyles(firstCell.attr("style"));
  const cellWidth = parseFloat(firstCellStyle["width"] || "0");
  const columns =
    cellWidth > 0 ? Math.max(1, Math.round(100 / cellWidth)) : $cells.length;

  const numberOfProducts = $cells.length;

  // Which display pieces does the cell reference?
  const showTitle = /\{\{\s*(?:item\.title|Title)\b/.test(cellText);
  const showPrice = /\{\{\s*(?:item\.price|Price|item\.regular_price|Compare_at)\b/.test(
    cellText,
  );
  const showImage = firstCell.find("img").length > 0;
  const $cellButton = firstCell.find("td[bgcolor] a, a[style*='background']").first();
  const showButton = $cellButton.length > 0;

  // Title styling — the innermost td wrapping {{ Title }} / {{ item.title }}.
  // Cheerio returns matches in document (descent) order, so .last() gives the
  // deepest td — the one that actually carries font-size/color styling.
  const $titleTd = firstCell
    .find("td")
    .filter((_, td) => /\{\{\s*(?:item\.title|Title)\b/.test($(td).text()))
    .last();
  const titleStyle = parseInlineStyles($titleTd.attr("style"));
  const titleFontSize = parsePx(titleStyle["font-size"]);
  const textColor = parseColor(titleStyle["color"]);
  const fontFamily = parseFontFamily(titleStyle["font-family"]);

  // Image styling
  const $img = firstCell.find("img").first();
  const imgStyle = parseInlineStyles($img.attr("style"));
  const imageCornerRadius = parsePx(imgStyle["border-radius"]) ?? 0;
  const maxHeight = parsePx(imgStyle["max-height"]);
  const imageSize: ProductImageSize =
    maxHeight == null ? "medium"
    : maxHeight <= 100 ? "small"
    : maxHeight <= 150 ? "medium"
    : "large";

  // Button styling (one button per cell in dynamic — use it for lineItemButtons)
  const lineItemButtons = $cellButton.length > 0
    ? extractInlineButton($, $cellButton)
    : defaultLineItemButton();

  const checkoutButton: InlineButton = {
    ...lineItemButtons,
    buttonText: "Checkout",
  };

  // Outer section: the component-wrapper div contains a table whose first
  // inner td carries section padding/background. Structure is:
  //   div.component-wrapper > table > tbody > tr > td[section padding here]
  const $wrapper = $product.closest(".component-wrapper");
  const $sectionTd = $wrapper.children("table").find("> tbody > tr > td").first();
  const outerStyle = parseInlineStyles($sectionTd.attr("style"));
  const sectionPadding = parsePadding(outerStyle);
  const sectionColor = outerStyle["background-color"] || "#ffffff";

  // Cart vs Best Sellers
  const cartContext = detectCartContext($);
  const pendingFilter = cartContext ? CART_ITEM_FILTER : BEST_SELLERS_FILTER;
  warnings.push(
    `Dynamic product block → ${pendingFilter.name} filter (${numberOfProducts} products × ${columns} cols). Verify in Redo editor after import.`,
  );

  const block: ProductsBlock = {
    type: "interactive-cart",
    blockId: nextId(),
    sectionPadding,
    sectionColor,
    textColor,
    fontFamily,
    titleFontSize,
    imageCornerRadius,
    checkoutButton,
    lineItemButtons,
    numberOfProducts,
    imageSize,
    productSelectionType: "dynamic",
    showPrice,
    showTitle,
    showImage,
    showButton,
    layoutType: columns === 1 ? "rows" : "grid",
    alignment: Alignment.CENTER,
    columns,
    stackOnMobile: true,
    manuallySelectedProducts: [],
    imageObjectFit: "cover",
    provider: "shopify",
    ...(cartContext ? { schemaFieldName: "cartContext" } : {}),
    _pendingFilter: pendingFilter,
  };

  return block as unknown as Section;
}

function extractInlineButton(
  $: $,
  $a: cheerio.Cheerio<El>,
): InlineButton {
  const aStyle = parseInlineStyles($a.attr("style"));
  const $bgTd = $a.closest("td[bgcolor]");
  const bgTdStyle = parseInlineStyles($bgTd.attr("style"));
  const fillColor =
    $bgTd.attr("bgcolor") ||
    bgTdStyle["background-color"] ||
    bgTdStyle["background"] ||
    aStyle["background-color"] ||
    aStyle["background"] ||
    "#000000";
  const cornerRadius =
    parsePx(bgTdStyle["border-radius"] || aStyle["border-radius"]) ?? 0;
  const borderShorthand = bgTdStyle["border"];
  let strokeColor = "transparent";
  let strokeWeight = 0;
  if (borderShorthand && borderShorthand !== "none") {
    const m = borderShorthand.match(
      /(\d+(?:\.\d+)?)\s*px\s+(?:solid|dashed|dotted)\s+(#[0-9a-fA-F]{3,8}|\w+)/,
    );
    if (m) {
      strokeWeight = parseFloat(m[1]);
      strokeColor = m[2];
    }
  }
  return {
    alignment: Alignment.CENTER,
    cornerRadius,
    buttonText: $a.text().trim() || "Shop now",
    padding: parsePadding(aStyle),
    fillColor,
    strokeColor,
    textColor: parseColor(aStyle["color"]),
    strokeWeight,
    fontFamily: parseFontFamily(aStyle["font-family"]),
    fontSize: parseFontSize(aStyle["font-size"]),
  };
}

function defaultLineItemButton(): InlineButton {
  return {
    alignment: Alignment.CENTER,
    cornerRadius: 8,
    buttonText: "Add to cart",
    padding: { top: 8, right: 16, bottom: 8, left: 16 },
    fillColor: "#ffffff",
    strokeColor: "#d6d6d6",
    textColor: "#000000",
    strokeWeight: 1,
    fontFamily: "Arial",
    fontSize: 16,
  };
}

// ─── Static fallback: decompose to COLUMN of images (existing MVP behavior) ──

function parseStaticProductBlock(
  $: $,
  $cells: cheerio.Cheerio<El>,
  warnings: string[],
): ColumnBlock | null {
  warnings.push(
    `Static product block with hardcoded content — decomposed to COLUMN of images. Title and button are dropped; consider converting to dynamic products in Redo.`,
  );

  const cols: (NonRecursiveBlock | null)[] = [];
  const widths: number[] = [];

  $cells.each((_, cell) => {
    const $cell = $(cell);
    const cellStyle = parseInlineStyles($cell.attr("style"));
    const width = parseFloat(cellStyle["width"] || `${100 / $cells.length}`);
    widths.push(width);

    const $img = $cell.find("img").first();
    if ($img.length > 0 && $img.attr("src")) {
      const $link = $img.closest("a");
      cols.push({
        type: EmailBlockType.IMAGE,
        blockId: nextId(),
        sectionPadding: { top: 0, right: 0, bottom: 0, left: 0 },
        sectionColor: "#ffffff",
        imageUrl: $img.attr("src") || "",
        altText: $img.attr("alt") || undefined,
        clickthroughUrl: $link.length > 0 ? $link.attr("href") : undefined,
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
      } satisfies ImageBlock);
    } else {
      cols.push(null);
    }
  });

  return {
    type: EmailBlockType.COLUMN,
    blockId: nextId(),
    sectionPadding: { top: 0, right: 0, bottom: 0, left: 0 },
    sectionColor: "#ffffff",
    columns: cols,
    columnCount: $cells.length,
    gap: 0,
    stackOnMobile: true,
    alignment: VerticalAlignment.TOP,
    columnWidths: widths,
  };
}

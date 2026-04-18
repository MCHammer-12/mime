import type {
  ColumnBlock,
  ImageBlock,
  InlineButton,
  NonRecursiveBlock,
  ProductFilterDoc,
  ProductImageSize,
  ProductsBlock,
  Section,
} from "../../renderer/types.js";
import {
  Alignment,
  EmailBlockType,
  Size,
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
import type { ParseContext } from "../index.js";
import type * as cheerio from "cheerio";

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
  ctx: ParseContext,
): Section[] {
  // Klaviyo ships two different cell-wrapper class names for static product
  // grids depending on editor version / template vintage:
  //   - `kl-product-cell-stack` (older, used by "stack" layouts)
  //   - `kl-product-subblock` (newer, used by current Klaviyo editor)
  // Match either — missing one drops whole product blocks silently.
  const $cells = $product.find(
    ".kl-product-cell-stack, .gxp-kl-product-cell-stack, .kl-product-subblock, .gxp-kl-product-subblock",
  );
  if ($cells.length === 0) return [];

  const isDynamic = $cells.toArray().some((cell) => {
    const txt = $(cell).text();
    return FEEDS_ITEM_RE.test(txt);
  });

  if (isDynamic) {
    const block = parseDynamicProductBlock($, $product, $cells, ctx);
    return block ? [block] : [];
  }
  return parseStaticProductBlock($, $cells, ctx);
}

// ─── Dynamic: interactive-cart block with pending filter ──────────

function parseDynamicProductBlock(
  $: $,
  $product: cheerio.Cheerio<El>,
  $cells: cheerio.Cheerio<El>,
  ctx: ParseContext,
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
  ctx.warnings.push(
    `Dynamic product block → ${pendingFilter.name} filter (${numberOfProducts} products × ${columns} cols). Verify in Redo editor after import.`,
  );

  const block: ProductsBlock = {
    type: EmailBlockType.PRODUCTS,
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
    layoutType: columns === 1 ? "rows" : "columns",
    alignment: Alignment.CENTER,
    columns,
    stackOnMobile: true,
    manuallySelectedProducts: [],
    imageObjectFit: "cover",
    provider: "shopify",
    ...(cartContext ? { schemaFieldName: "cartContext" } : {}),
    _pendingFilter: pendingFilter,
  };

  return block;
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

// ─── Universal Content Block: abandoned-cart line_items loop ───────
//
// Klaviyo "Abandoned Checkout Dynamic" (and similar) UCBs inline as raw
// Django template loops inside a `kl-table` — they don't use the
// `kl-product` block structure at all. Pattern:
//
//   <td class="kl-table">
//     <table>
//       {% if event.extra.line_items %}
//         <tbody>
//           {% for item in event.extra.line_items %}
//             <tr>... item.product.title, item.quantity, item.price ...</tr>
//           {% endfor %}
//         </tbody>
//       {% else %}<tbody></tbody>{% endif %}
//     </table>
//   </td>
//
// In Redo terms this is exactly a PRODUCTS block with
// `schemaFieldName: "cartContext"` + Cart Item filter. Redo's render
// time replaces the dynamic loop with real cart items.

const LINE_ITEMS_UCB_RE =
  /\{%\s*for\s+\w+\s+in\s+event\.extra\.line_items\s*%\}/;

/**
 * Web-safe font families we shouldn't promote to the brand kit.
 * (Mirrors the allowlist in fonts.ts — kept small/local to avoid a circular
 * import; fonts.ts is the source of truth for plan emission.)
 */
const UCB_WEB_SAFE = new Set([
  "arial",
  "helvetica",
  "helvetica neue",
  "times new roman",
  "times",
  "georgia",
  "courier new",
  "courier",
  "verdana",
  "tahoma",
  "trebuchet ms",
  "sans-serif",
  "serif",
  "monospace",
]);

/**
 * Walk every `font-family:` declaration in the UCB body and pick the
 * custom font that occurs most often. Outer containers (kl-table) carry
 * a generic stack (Ubuntu, Helvetica, ...) but inner spans — where the
 * actual visible text lives — carry the real brand font
 * (Kanit-Klaviyo-Hosted, ...). Dominant-by-count picks the brand font.
 *
 * Also strips the "-Klaviyo-Hosted" suffix Klaviyo adds to Google Fonts
 * when it self-hosts them (so "Kanit-Klaviyo-Hosted" → "Kanit").
 */
function extractPrimaryFont(html: string): string | null {
  const counts = new Map<string, number>();
  const re = /font-family:\s*([^;"}]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const families = m[1]!
      .split(",")
      .map((f) => f.trim().replace(/^['"]|['"]$/g, ""));
    for (const raw of families) {
      const normalized = raw.replace(/-Klaviyo-Hosted$/i, "").trim();
      if (!normalized) continue;
      if (UCB_WEB_SAFE.has(normalized.toLowerCase())) continue;
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
      break; // only count the first (primary) non-web-safe font per stack
    }
  }
  if (counts.size === 0) return null;
  // Highest count wins; ties broken by the one seen last (inner spans > outer).
  let best: string | null = null;
  let bestCount = -1;
  for (const [family, count] of counts) {
    if (count >= bestCount) {
      best = family;
      bestCount = count;
    }
  }
  return best;
}

export function parseLineItemsUcbBlock(
  $: $,
  $wrapper: cheerio.Cheerio<El>,
  ctx: ParseContext,
): ProductsBlock | null {
  const wrapperHtml = $wrapper.html() || "";
  if (!LINE_ITEMS_UCB_RE.test(wrapperHtml)) return null;

  // Section padding + color from the wrapper's outer td (same pattern as
  // other block parsers).
  const $sectionTd = $wrapper.children("table").find("> tbody > tr > td").first();
  const outerStyle = parseInlineStyles($sectionTd.attr("style"));
  const sectionPadding = parsePadding(outerStyle);
  const sectionColor = outerStyle["background-color"] || "#ffffff";

  ctx.warnings.push(
    `Cart items UCB (event.extra.line_items loop) → Products block with Cart Item filter. Verify styling in Redo editor.`,
  );

  // Extract the first custom font used inside the UCB loop body (Klaviyo
  // puts `font-family: Kanit-Klaviyo-Hosted, ...` on its spans). Pushing
  // it into the block's fontFamily lets buildFontPlan() see it and
  // auto-upload via the brand-kit pipeline on import.
  const fontFamily = extractPrimaryFont(wrapperHtml) ?? "Arial";

  const lineItemBtn: InlineButton = {
    ...defaultLineItemButton(),
    fontFamily,
  };
  const checkoutBtn: InlineButton = {
    ...lineItemBtn,
    buttonText: "Checkout",
    padding: { top: 16, right: 16, bottom: 16, left: 16 },
  };

  // Per-item "Add to cart" + overall "Checkout" buttons only show when the
  // Klaviyo UCB actually embedded one. Most abandoned-checkout templates
  // put their CTA in a separate image/button block (mapped via
  // image.clickthroughSchemaFieldName = "checkoutUrl") and the UCB has no
  // button at all — Redo's defaults would add both, so detect + hide.
  const hasEmbeddedButton = $wrapper.find(".kl-button").length > 0;

  return {
    type: EmailBlockType.PRODUCTS,
    blockId: nextId(),
    sectionPadding,
    sectionColor,
    textColor: "#000000",
    fontFamily,
    showCheckoutButton: hasEmbeddedButton,
    titleFontSize: 16,
    imageCornerRadius: 8,
    checkoutButton: checkoutBtn,
    lineItemButtons: lineItemBtn,
    // Klaviyo `{% for item in event.extra.line_items %}` inlines the loop
    // body once — the design represents a single item, repeated per cart
    // entry at send time. Default preview to 1 so the template matches the
    // source visually; real cart items hydrate at render time.
    numberOfProducts: 1,
    imageSize: "medium" as ProductImageSize,
    productSelectionType: "dynamic",
    showPrice: true,
    showTitle: true,
    showImage: true,
    showButton: hasEmbeddedButton,
    layoutType: "rows",
    alignment: Alignment.LEFT,
    columns: 1,
    stackOnMobile: true,
    manuallySelectedProducts: [],
    imageObjectFit: "cover",
    provider: "shopify",
    schemaFieldName: "cartContext",
    _pendingFilter: CART_ITEM_FILTER,
  };
}

// ─── Static: emit image-row + title-row, NO mobile stacking ───────
//
// Klaviyo static product blocks are hardcoded product grids (merchant
// picked specific products, not a recommendation feed). Redo's native
// PRODUCTS block requires Shopify product IDs (`productId` + `variantId`)
// which we can't recover from the HTML — the source only has
// `/products/<handle>` URLs. Best we can do: preserve the grid visually.
//
// We emit TWO stacked Column blocks per source row:
//   1. Column of product images (one cell per product, clickable to PDP)
//   2. Column of title text blocks (one cell per product)
//
// Both columns use `stackOnMobile: false` so on narrow screens the 2-wide
// grid stays 2-wide — keeping each title directly under its image. With
// the default `stackOnMobile: true` the mobile view would flatten to
// [img1, img2, title1, title2] which visually decouples them (first
// observed by user; see commit history).

function parseStaticProductBlock(
  $: $,
  $cells: cheerio.Cheerio<El>,
  ctx: ParseContext,
): Section[] {
  const n = $cells.length;
  if (n === 0) return [];

  ctx.warnings.push(
    `Static product block (${n} product${n === 1 ? "" : "s"}) — rendered as image + title columns (no price/button). Shopify product IDs aren't in the HTML, so this isn't a native Redo Products block. For click-to-cart / price / add-to-cart button, replace in Redo by inserting a Products block and picking the same products from the Shopify picker.`,
  );

  const imageCells: (NonRecursiveBlock | null)[] = [];
  const titleCells: (NonRecursiveBlock | null)[] = [];
  const widths: number[] = [];
  let titlesFound = 0;

  $cells.each((_, cell) => {
    const $cell = $(cell);
    const cellStyle = parseInlineStyles($cell.attr("style"));
    const width = parseFloat(cellStyle["width"] || `${100 / n}`);
    widths.push(width);

    const $img = $cell.find("img").first();
    if ($img.length > 0 && $img.attr("src")) {
      const $link = $img.closest("a");
      imageCells.push({
        type: EmailBlockType.IMAGE,
        blockId: nextId(),
        sectionPadding: { top: 0, right: 0, bottom: 0, left: 0 },
        sectionColor: "#ffffff",
        imageUrl: $img.attr("src") || "",
        altText: $img.attr("alt") || undefined,
        clickthroughUrl: $link.length > 0 ? $link.attr("href") : undefined,
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
        horizontalPadding: Size.CUSTOM,
        verticalPadding: Size.CUSTOM,
        showCaption: false,
      } satisfies ImageBlock);
    } else {
      imageCells.push(null);
    }

    // Title = first non-image text td in the cell. Klaviyo wraps it
    // after the image row, sometimes nested in additional tables.
    const $titleTd = $cell
      .find("td")
      .filter(
        (_, td) =>
          $(td).find("img").length === 0 && $(td).text().trim().length > 0,
      )
      .first();

    if ($titleTd.length > 0) {
      titlesFound++;
      const titleText = $titleTd.text().trim();
      const titleStyle = parseInlineStyles($titleTd.attr("style"));
      titleCells.push({
        type: EmailBlockType.TEXT,
        blockId: nextId(),
        sectionPadding: { top: 0, right: 0, bottom: 0, left: 0 },
        sectionColor: "#ffffff",
        text: `<p style="text-align:center;line-height:1.3;margin:0">${escapeHtml(titleText)}</p>`,
        textColor: parseColor(titleStyle["color"]),
        fontSize: parseFontSize(titleStyle["font-size"]) || 14,
        fontFamily: parseFontFamily(titleStyle["font-family"]) || "Arial",
        linkColor: parseColor(titleStyle["color"]),
      });
    } else {
      titleCells.push(null);
    }
  });

  const imageColumn: ColumnBlock = {
    type: EmailBlockType.COLUMN,
    blockId: nextId(),
    sectionPadding: { top: 0, right: 0, bottom: 0, left: 0 },
    sectionColor: "#ffffff",
    columns: imageCells,
    columnCount: n,
    gap: 0,
    // Keep 2-wide on mobile so title aligns directly under image.
    stackOnMobile: false,
    alignment: VerticalAlignment.TOP,
    columnWidths: widths,
  };

  if (titlesFound === 0) return [imageColumn];

  const titleColumn: ColumnBlock = {
    type: EmailBlockType.COLUMN,
    blockId: nextId(),
    sectionPadding: { top: 4, right: 0, bottom: 8, left: 0 },
    sectionColor: "#ffffff",
    columns: titleCells,
    columnCount: n,
    gap: 0,
    stackOnMobile: false,
    alignment: VerticalAlignment.TOP,
    columnWidths: widths,
  };

  return [imageColumn, titleColumn];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

# TODO-SHARED: Products block (interactive-cart)

Changes needed in shared files after parallel-work freeze lifts.

## `src/renderer/types.ts` — add enum value + interfaces

```ts
export enum EmailBlockType {
  // ...existing
  PRODUCTS = "interactive-cart",
}

export enum ProductImageSize {
  SMALL = "small",
  MEDIUM = "medium",
  LARGE = "large",
}

export enum ProductLayoutType {
  ROWS = "rows",
  GRID = "grid",
}

export enum ProductSelectionType {
  DYNAMIC = "dynamic",
  MANUAL = "manual",
}

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

export interface ManuallySelectedProduct {
  productId: string;
  variantId: string;
}

export interface ProductsBlock extends BaseBlock {
  type: EmailBlockType.PRODUCTS;
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
  manuallySelectedProducts: ManuallySelectedProduct[];
  imageAspectRatio?: number;
  imageObjectFit?: ObjectFit;
  schemaFieldName?: string;
  provider: "shopify";
  recommendedProductFilterId?: string;
}
```

Add `ProductsBlock` to the `NonRecursiveBlock` union (if we want it nestable — probably not per `column.ts` NESTABLE_TYPES; but it is a valid top-level Section). At minimum include it in `Section = NonRecursiveBlock | ColumnBlock | ProductsBlock`.

## `src/renderer/index.tsx` — componentMap (DONE with workaround)

`componentMap` now has `"interactive-cart": EmailProducts` registered. The map's type was widened from `Record<EmailBlockType, …>` to `Record<string, …>` so a string-literal key can coexist with enum keys. When `EmailBlockType.PRODUCTS` is added to the enum, revert the type to `Record<EmailBlockType, …>` and switch the key.

## Renderer stub: `src/renderer/blocks/product.tsx` (DONE — placeholder only)

Implemented as a placeholder grid for preview purposes. Draws N cells matching `columns`/`numberOfProducts` using the block's own styling (title font, colors, button style). Real product data is server-hydrated via the filter; this stub only conveys layout + style.

Future work:
- Accept a `sampleProducts` prop for a richer preview
- Real image loading for manual-selection mode

## Parser produces a `_pendingFilter`, not a `recommendedProductFilterId`

Parser output contains a non-prod field `_pendingFilter: ProductFilterDoc`. The executor (redo/manage import script, not yet built per the existing `reference_template_import_path` memory) must:

1. POST `_pendingFilter` body to `https://app-server.getredo.com/marketing-rpc/createProductFilter`
2. Take `output.productFilterId` from the response
3. Set `block.recommendedProductFilterId = productFilterId` and delete `block._pendingFilter`
4. Then call `EmailTemplateRepo.createTemplate` with the cleaned sections

## Column nesting

Current `column.ts` NESTABLE_TYPES excludes products (via the "product or complex layout" bail-out). That's correct — interactive-cart shouldn't live inside a Redo column. No change needed; just don't add `EmailBlockType.PRODUCTS` to NESTABLE_TYPES.

## Import dispatcher already handles it

`src/parser/index.ts` dispatches `kl-product` to `parseProductBlock` (line 149). No change needed in the dispatcher — the parser now decides statically vs dynamically internally.

## Unresolved

- `imageSize` bucket thresholds (small/medium/large) — I used `<=100 / <=150 / else`; confirm with Redo editor's actual size options.
- `layoutType = "grid"` vs `"rows"` — I set `rows` only when `columns === 1`. Verify that "grid" is the right value for multi-col; Redo may use a different enum value.
- Whether `schemaFieldName: "cartContext"` should be set for dynamic blocks in cart/checkout flow templates. I currently set it only when cart-context signal (`{% for item in event.extra.line_items %}`) is detected anywhere in the template. May need refinement.

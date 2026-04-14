# TODO (shared) — discount block

Changes made outside `blocks/discount.ts` that are shared-file edits
(for review before merging the discount element work).

## `src/parser/index.ts` (dispatcher)

Added import and wired `tryParseDiscountFromText` into the `kl-text`
branch. Discount splitting now runs *after* the footer check and *before*
the normal `parseTextBlock` call. When it returns a non-null array, we
push those blocks (text + discount + text) and skip the text parser for
this wrapper.

Shape:

```ts
import { tryParseDiscountFromText } from "./blocks/discount.js";
// ...
const discountSplit = tryParseDiscountFromText($, $first, warnings);
if (discountSplit) {
  blocks.push(...discountSplit);
  return;
}
```

## `src/renderer/blocks/discount.tsx`

Added a `"XXXXXX"` fallback when `props.discountCode` is missing outside
of the builder environment. During migration parsing we don't yet have a
Redo discount object linked, so `discountCode` is undefined — the
renderer would previously show an empty block. The change is minimal and
only affects the undefined-code case; production rendering with a real
`discountCode` is unchanged.

## Followups (not done here)

- `blocks/text.ts` still has `extractCouponCodes` / `stripStandaloneCoupons`
  helpers. `stripStandaloneCoupons` is now redundant for standalone coupons
  that we route through the discount splitter, but it stays useful as a
  safety net for anything my regex misses and for the text-clone path
  (segments passed to `parseTextBlock` still get stripped, which is fine).
  Consider deleting once coverage is proven.
- The parsed `DiscountBlock` does not carry the Klaviyo coupon name
  (e.g. `"AbandonedCheckout"`). Per the project memory on discount
  migration, the user provides a prefix + amount and we generate a real
  Redo discount — the Klaviyo name isn't the mapping key. If we later
  want it for auditing, add an optional `_source?: { couponName: string }`
  field.
- Inline coupons mid-sentence are intentionally left in the text block
  for a later AI rewrite pass.

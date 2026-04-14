# Button block: session wrap-up & follow-up work

Completed in this session: pixel-correct button parsing across a diverse set of templates (transactional Shopify, abandoned cart, modern campaigns, discount giveaway, newsletter, gift card, password reset). Fill/text/stroke color, corner radius, fontFamily/fontSize, alignment, full-width detection, section padding, button padding, and link classification are handled correctly. Fixes are isolated to `src/parser/blocks/button.ts` and `src/renderer/blocks/button.tsx`.

Key architecture additions:
- **Section padding** comes from the outer wrapper `<td>` (navigating up via `$td.closest("table").parent("td")`), not the `kl-button` `<td>` which is always `padding:0`.
- **Stroke extraction** (`parseBorderStroke`) only emits a uniform stroke when all four border sides match. Klaviyo's common shadow pattern (`border:none; border-bottom:solid 2px ...`) correctly drops to `strokeColor: transparent, strokeWeight: 0` rather than painting a thick border all around the button.
- **Three-state link classification** for Klaviyo `{{ }}` variables in button hrefs:
  - Known-mapped (via `mapKlaviyoLink`) → passes as `dynamic-variable`
  - Explicitly unsupported (`UNSUPPORTED_VARIABLES` list) → `UNSUPPORTED:` warning → template routes to manual migration
  - Unknown / new variable → `REVIEW:` warning → surfaces on a review list so the user can classify later

---

## PRIORITY 0: Shared-file changes (replace warning-prefix convention)

The button parser currently piggy-backs on `warnings: string[]` with `UNSUPPORTED:` / `REVIEW:` prefixes because the per-element plan freezes `src/parser/index.ts`. Once the dispatcher is unfrozen, replace with proper fields on `ParseResult`:

```ts
export interface ParseResult {
  sections: Section[];
  warnings: string[];
  unsupportedFeatures: UnsupportedFeature[]; // blocks template
  reviewItems: ReviewItem[];                  // non-blocking, collected for user review
  bodyBackgroundColor: string;
}

interface UnsupportedFeature {
  blockType: EmailBlockType;
  reason: string;   // e.g. "gift_card dynamic variable in button link"
  context: string;  // raw value, e.g. "{{ gift_card.url }}"
}

interface ReviewItem {
  blockType: EmailBlockType;
  variableName: string; // e.g. "organization.url"
  context: string;      // raw href
}
```

Update `parseColumnContent` in `index.ts` to thread these through, and update block parsers to push to the right array. Remove the `UNSUPPORTED:` / `REVIEW:` prefix convention from `button.ts`.

---

## PRIORITY 1: Migration script: REVIEW list integration

The `REVIEW:` warnings need an end-of-run aggregation step in the migration script:

1. Walk all parsed templates, collect `REVIEW:` warnings
2. Dedupe by variable name, count templates per variable
3. Output a ranked list:
   ```
   Variables to classify:
     organization.url (23 templates)
     event.CustomerFirstName (5 templates)
     ...
   ```
4. For each, user decides: add to `mapKlaviyoLink` (treats as dynamic-variable) or add to `UNSUPPORTED_VARIABLES` (blocks template). Re-run.

Same pattern should work for image clickthroughs and any other URL-carrying block — call `mapKlaviyoLink`, emit `UNSUPPORTED` / `REVIEW` using the same classifier.

---

## PRIORITY 2: Full-width button horizontal padding loss

Klaviyo's MJML-to-HTML compile zeroes out horizontal padding on the `<a>` for `width:100%` buttons. The editor stores a real value (e.g. 37px) but it's unrecoverable from exported HTML.

Current behavior: we extract `padding.left: 0, padding.right: 0` faithfully from the HTML. This is technically correct but may look wrong in Redo's editor for full-width buttons (the internal padding collapses if the user toggles off full-width).

**Options if this surfaces as a visual regression:**
- Apply a sensible default horizontal padding for full-width buttons when the extracted value is 0 (e.g. match vertical padding, or a fixed value)
- Leave as-is and fix in Redo's editor post-import

Low priority — revisit only if users report visual issues on full-width buttons after migration.

---

## PRIORITY 3: Silently-dropped style fields

Extracted by Klaviyo HTML but not captured by the parser because no matching field exists on Redo's ButtonBlock:

| Field | Klaviyo source | Example | Notes |
|---|---|---|---|
| `font-weight` | `<a>` inline style | `font-weight: 400` or `700` | Renderer hardcodes `fontWeight: "bold"` so the value wouldn't matter until the renderer reads it from state |
| `letter-spacing` | `<a>` inline style | `letter-spacing: 1px` (discount-giveaway) | No schema field |
| `text-transform` | `<a>` inline style | `text-transform: none` or `uppercase` | No schema field |

**Action:** if a visual regression surfaces, add these fields to `ButtonBlock` type + renderer reads, then update `button.ts` to extract them. Until then, no-op.

---

## Cross-cutting observations

### Link classification is a cross-block problem

`mapKlaviyoLink` currently handles only button hrefs. Image clickthroughs (`<a class="kl-img-link">`) and any other URL-carrying blocks need the same three-state classification (mapped / unsupported / review). Worth pulling the classifier helper (`classifyVariable`, `extractVariableName`) out of `button.ts` into `url-mapping.ts` for reuse.

### `UNSUPPORTED_VARIABLES` belongs in `url-mapping.ts`

The list of explicitly-unsupported variables is not button-specific — it's about which Klaviyo variables Redo can't resolve. Moving it to `url-mapping.ts` alongside `mapKlaviyoLink` is the right long-term home. Deferred because `url-mapping.ts` is effectively a shared file for any block that carries URLs.

### Font + custom styling handoff to text block's font pipeline

When the font provisioning pipeline from the text block's TODO-SHARED lands (Priority 2 there), it needs to also walk button `fontFamily` fields. Already called out in the text TODO under "Template-level font collection."

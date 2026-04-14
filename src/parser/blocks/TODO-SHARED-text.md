# Text block: session wrap-up & follow-up work

Completed in this session: pixel-correct text rendering for plain newsletter content (padding, line-height, alignment, font inheritance, block-level element handling), plus scaffolding utilities (`extractCustomFonts`, `extractCouponCodes`, `stripStandaloneCoupons`). Fixes are isolated to `src/parser/blocks/text.ts` and `src/renderer/blocks/text.tsx`.

What remains is grouped by priority. Most of it is out of scope for a per-element parser — it lives in the export pipeline, requires shared type changes, or needs infrastructure (LLM, Redo API, S3).

---

## PRIORITY 0: Footer variables render empty

Klaviyo footer text blocks use variables Redo either strips or has no equivalent for:

| Klaviyo variable | What happens in Redo |
|---|---|
| `{% unsubscribe %}` | Redo's Liquid processor silently strips it (renders empty) |
| `{{ organization.name }}` | No such variable — renders empty |
| `{{ organization.full_address }}` | No such variable — renders empty |

**Decision (2026-04-14): keep as Text block, not Footer block.**

Originally planned to convert to Redo's `FooterBlock`. Reversed after
prototyping the footer element viewer — Redo's Footer block is too rigid:
it forces its own copy/order ("business name / address / city-state-zip /
country / Unsubscribe"), destroying the original Klaviyo preamble like
"No longer want to receive these emails?" and any merchant customization.

The Text block preserves original copy + order verbatim. Redo accepts
`{{ unsubscribe_link }}` directly inside Text `text` fields — confirmed
by `hasUnsubscribeLink` in `redo/web/.../unsubscribe-link-warning-modal.tsx`,
which treats `text.includes("{{ unsubscribe_link }}")` as a valid
unsubscribe for compliance purposes.

**Transformation:**

1. Detect footer-style text blocks (contain `{% unsubscribe %}` OR
   `{{ organization.* }}`).
2. In the text HTML, replace:
   - `{% unsubscribe %}` → `<a href="{{ unsubscribe_link }}">unsubscribe</a>`
     (link text copied from the original anchor text if Klaviyo wrapped
     it, otherwise literal "unsubscribe")
   - `{{ organization.name }}` → `manifest.account.organizationName`
   - `{{ organization.full_address }}` → formatted address string from
     `manifest.account.address`
3. Leave block as Text. No block-type conversion.

**Where org name/address come from (in priority order):**

1. **Klaviyo Accounts API** — `GET /api/accounts/` returns
   `contact_information` with `organization_name`, `street_address`,
   `city`, `region`, `zip`, `country`. Fully automated, matches what
   merchants see in Klaviyo.
2. **User-entered fallback** — prompt merchant at migration start.
   Placeholders are not acceptable; if the API call fails, the
   migration must prompt before proceeding.

Either way, store in `manifest.json` under a new `account` key:
```json
{ "merchant": "...", "account": { "organizationName": "...", "address": {...} }, "templates": [...] }
```

**Migration steps:**
1. Pull step: call Klaviyo Accounts API, fall back to user prompt.
2. Export step: for each text block, run the variable substitution above.

**Abandoned work:** `src/parser/blocks/footer.ts`,
`src/renderer/blocks/footer.tsx`, and `TODO-SHARED-footer.md` were
created and deleted. The dispatcher branch in `src/parser/index.ts`
and the renderer's componentMap were reverted.

---

## PRIORITY 1: `{% coupon_code %}` → Redo discount block

Klaviyo templates use `{% coupon_code 'CouponName' %}` inline in text blocks. Redo has no inline equivalent — discounts are a separate block type.

**Two patterns observed:**
- **Standalone**: coupon on its own line with `<br>` separators. Mechanical removal works (`stripStandaloneCoupons`, already wired into parser).
- **Inline**: coupon embedded in a sentence like "Just use code {% coupon_code %} at checkout". Requires AI rewrite.

**Already built in `text.ts`:**
- `extractCouponCodes(html)` returns `{ couponName, isStandalone, inferredAmount, inferredType }[]`. Amount/type inferred from surrounding text via regex (e.g. "10% discount" → percentage, 10).
- `stripStandaloneCoupons(html)` removes standalone variants plus surrounding `<br>`.

**What still needs building (in export pipeline, not parser):**

### A) Create a Redo discount object via API

For each detected coupon, create a discount object with:
- **name**: Klaviyo coupon name (e.g. "AbandonedCart")
- **type**: percentage or amount off — use `inferredType` from `extractCouponCodes`, fall back to AI or user prompt
- **code generation strategy**: dynamic
- **discount code prefix**: **user-provided per migration** (e.g. "QUIK"). Collect in migration config before import.
- **discount amount**: use `inferredAmount` from `extractCouponCodes`, fall back to AI or user prompt
- **combine discount with**: none
- **item restrictions**: none
- **expiration**: never
- **minimum quantity**: 0
- **minimum purchase amount**: 0.00
- **customer eligibility**: all customers
- **total number of uses**: unlimited
- **limit to 1 use per customer**: true

### B) Insert a DiscountBlock after the text block

Styled to match the text block above it:
- `fontFamily` → text block's inline font (e.g. Alegreya Sans from inline span, not the outer div's Helvetica Neue)
- `alignment` → center
- `fontWeight` → match the text above
- `fontSize` → 32
- `textColor` → match text block's textColor or inline span color
- `blockBackgroundColor` → match text block's sectionColor
- `sectionColor` → match text block's sectionColor
- `discountId` → the discount object created in step A

### C) AI-rewrite the surviving text (per-section call)

Even with `stripStandaloneCoupons`, the text reads awkwardly ("Use the code below: And the discount will be applied automatically!"). For inline coupons, the sentence must be restructured entirely.

Example:

Before:
```
Your 10% discount expires in just 24 short hours.
Use the code below:
{% coupon_code 'AbandonedCart'%}
And the discount will be applied automatically!
```

After:
```
Your 10% discount expires in just 24 short hours.
Use the code below and the discount will be applied automatically!
```

Use one LLM call per section (see feedback memory on this). Pass just this text block's content + context about the coupon removal.

---

## PRIORITY 2: Font provisioning pipeline

Templates use custom fonts (e.g. "Alegreya Sans") in inline `<span>` styles. Text HTML preserves them, but they won't render without `@font-face` rules in the email `<head>`.

**Already built:**
- `extractCustomFonts(html)` in `text.ts` — scans for non-web-safe font-family declarations, decodes HTML entities, filters out web-safe + system fonts (arial, helvetica, verdana, geneva, etc.).

**What still needs building (export pipeline):**

1. **Template-level font collection** — `extractCustomFonts` only scans text blocks. Other block types (button, menu, header, discount) also have `fontFamily` fields. Run font collection across all blocks, not just text.
2. **Font source resolution** — Google Fonts API covers most Klaviyo defaults (Alegreya Sans, etc.). Build a resolver: font name → downloadable source URL.
3. **Download + convert** — fetch the font files, convert to WOFF2 if needed.
4. **Upload to S3** — per Redo's brand kit structure.
5. **Register in brand kit** — call Redo API to populate `team.settings.brandKit.customFontFamilies`:
   ```
   { fontFamily: "Alegreya Sans", fallbackFont: "Verdana, Geneva, sans-serif",
     styles: [{ fontName, fontStyle, weight, italic, fontFileUrl }] }
   ```
6. **Render-time**: Redo's `generateCustomFontCSSForFamily()` handles `@font-face` injection automatically once fonts are registered. No renderer changes needed.

---

## PRIORITY 3: Upstream `parsePadding` bug

`parsePadding` in `src/parser/style-utils.ts` returns early when shorthand `padding` exists, ignoring individual `padding-top/right/bottom/left` overrides. Klaviyo templates commonly use `padding: 0px; padding-top: 18px; ...` which silently zeroes everything.

**Workaround in this session:** `parsePaddingWithOverrides` local to `text.ts`, applies CSS cascade correctly.

**Action:** Upstream the fix to `style-utils.ts` so all block types benefit. Every other block type likely has the same latent bug.

---

## PRIORITY 4: Type additions for TextBlock

These properties are extracted from the Klaviyo div wrapper but not in the Zod schema. Embedded inline in the `text` HTML as workarounds for now:

- `lineHeight: string` — extracted from div style, wrapped in `<div style="line-height: X">`. All Klaviyo templates tested use 1.3; Redo renderer defaults to 1.42.
- `textAlign: string` — extracted from div style, applied to `<p>` tags. Matters for center-aligned footer blocks.

Current approach (embedding in HTML) works but is leaky. Cleaner long-term: add these fields to TextBlock type, update the renderer to read them from props, drop the HTML wrappers.

---

## Cross-cutting observations (apply to later phases)

### Cross-block transformations are becoming the core problem

Per-block parsers are done for most simple cases. The remaining work (coupons, footers, buttons-from-images, font collection) all need logic that **spans blocks**. Recommend adding a post-parse transformation pass that operates on `Section[]` — detecting patterns across blocks, inserting/removing blocks, modifying text based on sibling context.

This lives in the export pipeline (`src/export-template.ts` or a new module), not in per-block parsers.

### AI calls: one per section (reined-in)

For coupon rewrites, amount inference, image-as-button conversion, etc. — prefer one LLM call per section over batched template-level calls. Accuracy over cost. Pass only the context that section needs (the block itself, maybe 1-2 neighbors if relevant).

### Type-sync pass

Changes piling up: lineHeight, textAlign on TextBlock; FooterBlock type; font-family fields across other blocks; horizontalPadding/verticalPadding on Image and Line; showCaption on Image; etc. Worth a dedicated type-sync pass once all parallel element work wraps, rather than patching one at a time.

### User-provided migration config

Several items need merchant input before migration can start:
- Discount code prefix per Klaviyo coupon name (e.g. "AbandonedCart" → "QUIK")
- Org name + address (if not using Klaviyo Accounts API)

Recommend a single migration-config file/prompt at the start that collects everything, then the pipeline is fully automated.

# Buttercup Lynne feedback — 2026-05-26

Source: troubleshoot bundle `troubleshoot-Buttercup Lynne-2026-05-13T01-32-14-610Z.zip`
Job: `46d7a3bd-fff9-4555-a7c5-c7ad0fb0d5ed` (storeId `mcht/66a1048937e5bab8a986a129`)
Items: 4 flows flagged (6 emails total imported)

## Tasks (Buttercup-specific)

| # | Status | Task | Branch | PR |
|---|--------|------|--------|----|
| 1 | unclaimed | [Customer Winback flow — no product image](customer-winback-no-product-image.md) | `fix/customer-winback-no-product-image` | — |
| 2 | unclaimed | [Browse Abandonment — "Spacy was applied" (spacing regression)](browse-abandonment-spacing.md) | `fix/browse-abandonment-spacing` | — |
| 3 | unclaimed | [Browse Abandonment — socials block has wrong colors](socials-wrong-colors.md) | `fix/socials-wrong-colors` | — |

## Collapsed into other batches

| Issue | Owning task |
|-------|-------------|
| `Abandoned Checkout Reminder` — "no product filter" | [Charlie Task 9 (flow product filter + re-entry)](../2026-05-26-charlie-1-horse/flow-product-filter-reentry.md) — extend scope to cover Cart Abandonment trigger (currently scoped to BA only) |
| `Browse Abandonment` — "no product image" | [Charlie Task 7 (BA dynamic product variable)](../2026-05-26-charlie-1-horse/browse-abandonment-dynamic-product.md) |
| `Review request` — "no rating table" | [Fairechild Task 1 (product rating blocks)](../2026-05-26-fairechild/product-rating-blocks-missing.md) — same Yotpo/Klaviyo-Reviews rating widget |
| Font size/family wrong across 3 flows | Cross-merchant font pattern (Charlie Task 4 / Blackline / GPA Task 2) — **6th merchant reporting** |

## Cross-cutting notes

**Klaviyo API key provided by Michael** (`pk_SiaZ66_...`). Don't write into files/commits — executors pull at execution time.

**Font issue is now 6/6 merchants this batch.** Strong signal that the cross-merchant font tasks aren't a per-merchant accident — there's likely a real systemic issue. Worth a planner pass to consolidate once at least one of Charlie 4 / Blackline / GPA 2 lands.

**Charlie Task 9 scope expansion.** Currently scoped to Browse Abandonment specifically. Buttercup's AC report ("no product filter") expands the symptom to Cart Abandonment too. The executor on Charlie Task 9 should generalize to "flow-level product filters across all triggers" rather than BA-only. Updated guidance worth adding to that task file when it gets claimed.

**Buttercup contact info:**
- storeId: `mcht/66a1048937e5bab8a986a129`

**Flow IDs:**
- YhCuqC — Abandoned Checkout Reminder (Email) — collapsed (Charlie Task 9 + font)
- R8rs5s — Browse Abandonment — Tasks 2 + 3 + collapsed (Charlie Task 7 + font)
- X3Wwpd — Customer Winback - Standard — Task 1
- YekdPM — Review request — collapsed (Fairechild Task 1 + font)

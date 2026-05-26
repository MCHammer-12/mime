# Charlie 1 Horse feedback — 2026-05-26

Source: troubleshoot bundle `troubleshoot-Charlie 1 Horse-2026-05-21T17-17-15-970Z (1).zip`
Job: `f8663182-387b-404e-a90f-c6d28e71ba9f` (storeId `mcht/653eab6131a3130006e053d5`)
Items: 6 templates + 2 flows, all flagged with notes

## Tasks

| # | Status | Task | Branch | PR |
|---|--------|------|--------|----|
| 1 | done | [Universal block duplication across all 6 templates](universal-block-duplication.md) | `fix/universal-block-duplication` | [#75](https://github.com/MCHammer-12/mime/pull/75) |
| 2 | blocked | [AC product block static instead of dynamic cart-items](ac-product-block-dynamic-cart.md) | `fix/ac-product-block-dynamic-cart` | — |
| 3 | done | [Inline anchor in text retains Klaviyo checkout URL](inline-anchor-url-rewrite.md) | `fix/inline-anchor-url-rewrite` | [#77](https://github.com/MCHammer-12/mime/pull/77) |
| 4 | done | [First text wrong font-size + missing font-family](first-text-font-styling.md) | `fix/first-text-font-styling` | [#76](https://github.com/MCHammer-12/mime/pull/76) |
| 5 | unclaimed | [Footer buttons joined without spacing](footer-button-spacing.md) | `fix/footer-button-spacing` | — |
| 6 | blocked | [Image click-through links missing](image-clickthrough-links.md) | `fix/image-clickthrough-links` | — |
| 7 | unclaimed | [Browse abandonment dynamic product variable not mapped](browse-abandonment-dynamic-product.md) | `fix/browse-abandonment-dynamic-product` | — |
| 8 | unclaimed | [Abandoned Cart flow — profile filters not migrated](flow-profile-filters.md) | `fix/flow-profile-filters` | — |
| 9 | unclaimed | [Browse Abandonment flow — product filter + re-entry criteria not migrated](flow-product-filter-reentry.md) | `fix/flow-product-filter-reentry` | — |

## Cross-cutting notes

**Task 1 blocks visual verification of Tasks 4, 5, 6.** If everything in a template is duplicated, the executor for Task 5 (footer buttons) can't tell whether their fix worked or just shipped two buggy footers. Task 1 should go first; Tasks 2-9 can run in parallel after.

**Source HTML not in the bundle.** The bundle only contains `parse-result.json` (summary metadata) + `notes.md`, not the original Klaviyo HTML. Executors for template-level tasks (1, 3, 4, 5, 6) need to either:
- Re-fetch via `/api/debug/resolve-template` on the Replit deploy (`POST {merchantSlug: "Charlie 1 Horse", templateId: "<RYhKut|…>"}`), OR
- Pull the template HTML from Charlie 1 Horse's Klaviyo account directly via API key (in `stores` table)

The 6 template IDs are: `RYhKut`, `WeieJr`, `SxWYeY`, `WgXbn6`, `U3cE5u`, `VRDxJu`.

**Suspected font issue interaction.** Charlie 1 Horse uses Aleo, Apple Gothic, Century Gothic, Century Gothic Charlie, Poppins. Per `parse-result.fontPlanEntries`, only Aleo + Century Gothic + Poppins are available; Apple Gothic + Century Gothic Charlie are missing. Task 4 (first-text font) may partially overlap with the missing-font preflight (`src/parser/font-plan.ts`) — executor should check whether the first-text uses one of the missing families.

**Per-template feedback mapping** (for tracing each note back to a task):

| Template | Tasks | Verbatim feedback |
|----------|-------|-------------------|
| RYhKut (Welcome 3) | 1, 4, 5, 6 + image-column-padding¹ | header/images/text×2/products/footer/socials duplicated; products 3×2 → 3×1+dup; socials 3 instances; footer btn no-space; images no link; col image no padding |
| WeieJr (Welcome 2) | 1, 4, 5, 6 | header/text×2/products/footer/socials duplicated; footer btn no-space; images no link |
| SxWYeY (Welcome 1) | 1, 4, 5, 6 + text-padding² + wrong-image-asset³ | header/menu/texts/button/footer/socials duplicated; first-text wrong font; no padding on 2nd text; wrong product image for Felt/Straw |
| WgXbn6 (AC Email 2) | 1, 2, 3, 4, 5, 6 | header+menu 2x; AC product = static image not dynamic cart-items; "complete purchase" → Klaviyo URL; return-to-cart btn dup |
| U3cE5u (AC Email 1) | 1, 2, 3, 4, 5, 6 | (same as WgXbn6) |
| VRDxJu (Browse Aband.) | 1, 4, 5, 7 | header/texts/shop-now/footer/socials dup; "Product image not found" — `{{ event.Name }}` variable not mapped |

¹ ² ³ Single-template issues folded into Task 1's discovery — almost certainly artifacts of the duplication bug or padding regression. Pull out as separate tasks only if Task 1's fix doesn't resolve them.

**Charlie 1 Horse contact info** (substituted at parse time, useful for spot-checking output):
- `organization.url` → `http://www.charlie1horsehats.com`
- `organization.name` → `Charlie 1 Horse Hats`
- `organization.full_address` → `601 Marion Drive, Garland, Texas 75042, United States`

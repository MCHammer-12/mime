---
status: blocked
branch: fix/post-purchase-images-and-links-wrong
pr: null
---

# Post Purchase Email 1 images wrong + Email 2-3 links wrong

## Feedback (verbatim)

Castle Sports `[EG] Post Purchase Flow` (UQJH6z):

> Also, the images were not correct, the font s were not accurate and the links were wrong for Email 2 and 3.

Parsing the merchant's wording:
- **Email 1**: "images were not correct"
- **Email 2 + 3**: "links were wrong"
- (fonts collapsed to existing font tasks — separate concern)

## Root cause

**For Email 1 wrong images:** could mean
- Wrong product image URLs (placeholder vs. final asset, or a Klaviyo CDN URL mime doesn't know how to rewrite)
- Image src attributes pulled from wrong DOM position (e.g. `<img>` inside a hidden / mobile-only block, sibling instead of intended)
- Image hosted on Klaviyo's CDN with an expiring URL that's since 404'd
- Image variable like `{{ event.ImageURL }}` not substituted

**For Email 2 + 3 wrong links:** could mean
- Anchor `href` values rewritten incorrectly (same family as Charlie Task 3 inline-anchor-url-rewrite, but a different anchor pattern that's not yet covered)
- Klaviyo variable URLs (`{{ event.URL }}`, `{{ checkout_url }}`, `{{ organization.url }}`) substituted to wrong values
- Static URLs from the Klaviyo source dropped or replaced

Relevant files:
- [`src/parser/blocks/image.ts`](src/parser/blocks/image.ts) — image block parser
- [`src/parser/blocks/button.ts`](src/parser/blocks/button.ts) — button block parser (where most links live)
- [`src/parser/blocks/text.ts`](src/parser/blocks/text.ts) — inline anchors (covered by Charlie Task 3)
- [`src/parser/url-mapping.ts`](src/parser/url-mapping.ts) — URL rewriting, Klaviyo variable mapping table

## Proposed change

1. **Pull source HTML** for Email 1, 2, 3 of the Post Purchase flow (need Klaviyo API key for Castle).
2. **For each issue, identify the specific URL or image** that's wrong. Compare Klaviyo source `src=` / `href=` with what landed in Redo. This is the diagnosis step — capture the exact pattern.
3. **Categorize:**
   - **Image src problems**: probably block parser misreading. Patch [`image.ts`](src/parser/blocks/image.ts).
   - **Link URL problems on buttons**: probably url-mapping table missing a Klaviyo variable. Add to [`url-mapping.ts`](src/parser/url-mapping.ts).
   - **Link URL problems on inline anchors**: see if Charlie Task 3 (inline-anchor-url-rewrite) covers it; if yes, mark this resolved-by. If no, the missing pattern is a different anchor structure — patch.
4. Smoke test each new pattern.

## Verify

- Re-import Castle's Post Purchase flow: Email 1 images match Klaviyo source; Email 2 + 3 link URLs match (or correctly rewrite to Redo equivalents like `<storeUrl>/cart` per existing PR #43 logic)
- Smoke tests pass
- Regression: historical corpus image + link parsing unchanged

## Notes

- Coordinate with Charlie Task 3 (inline-anchor-url-rewrite) — if their fix lands first, may resolve part of this. Read their PR + see if the same anchor pattern Castle hits is covered.
- Post Purchase Email 1 is also covered by Task 2 (subject/preview). If both Tasks 2 + 3 land at once for the same email, fine — but coordinate the verification step so each PR has the right scope.
- The "fonts not accurate" piece of the original merchant note is intentionally NOT in this task — that's covered by the existing cross-merchant font tasks (Charlie Task 4, Blackline, etc).

## Notes — executor investigation 2026-05-26

**The parser is doing what it should on every image + link** for all 3
Post Purchase emails. Comparing Klaviyo source vs. post-transform output:

**Email 1 (RUpF6R)** — 3 images, 1 button:

| # | Element | Klaviyo source | Post-transform |
|---|---------|----------------|----------------|
| 1 | img `aac790db…gif` (alt "CASTLE SPORTS - THANK YOU") | href `https://castlesports.com/` | clickthroughUrl `https://castlesports.com/` ✓ |
| 2 | img `4c8700d9…gif` (alt "Any Place, Any Time") | href `https://castlesports.com/` | ✓ |
| 3 | img `910de595…gif` (alt "Any place, any time!") | href `https://castlesports.com/` | ✓ |
| 4 | button "SHOP NOW" | href `https://castlesports.com/` | buttonLink ✓ |

**Email 2 (SqEd95)** — 2 images, **no buttons in source**:

| # | Klaviyo source | Post-transform |
|---|----------------|----------------|
| 1 | img `62e18d3e…gif` href `https://castlesports.com/` | clickthroughUrl ✓ |
| 2 | img `48989021…gif` href `https://castlesports.com/` | ✓ |

**Email 3 (Ugb6QN)** — 2 images, no buttons in source:

| # | Klaviyo source | Post-transform |
|---|----------------|----------------|
| 1 | img `17aca2de…gif` href `https://castlesports.com` (no trailing slash) | ✓ |
| 2 | img `abd9097b…png` href `https://castlesports.com` | ✓ |

Body text `{{ first_name|default:'there' }}` also correctly rewrites to
`{{ customer_first_name |default:'there' }}` via the existing
`mapProfileVars` path in [`src/transform.ts`](../../../src/transform.ts).

**Why the merchant says it's wrong is unclear from this side:**

- Possibly the merchant authored these emails in Klaviyo with all 3
  hero/banner images pointing at `castlesports.com` (their homepage) and
  was hoping mime would magically rewrite them to product-specific URLs.
  That's not something a parser can do without per-image intent — would
  need merchant input or AI.
- Possibly downstream (Redo importer or editor) shows the images
  differently than expected — animated GIFs may not render in some
  preview contexts.
- Possibly the troubleshoot bundle (captured 2026-05-20) reflected
  pre-Task-2 state where `{{ first_name|default:'X' }}` showed
  literally in the SUBJECT and merchant conflated that with body / image
  issues.

**Recommended unblock path:**

Re-import Castle Sports Post Purchase flow post-#89 (Task 2 fix) merge
and have the merchant point at the specific image/link they consider
"wrong." Without that, mime has no actionable target — every
mechanically-extractable URL already matches Klaviyo source.

Marking `blocked` — needs merchant clarification on which specific
image/link is wrong, or a re-import bundle showing the discrepancy.

## Done

(filled by executor on completion)

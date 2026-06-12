---
status: blocked
branch: fix/image-clickthrough-links
pr: null
---

# Image blocks emitted without click-through links

## Feedback (verbatim)

- RYhKut: "Images are without links"
- WeieJr: "Images are without links"
- SxWYeY: "Link not added to image"
- WgXbn6: "Image does not have a link"
- U3cE5u: "Image does not have a link"

i.e. the original Klaviyo image was wrapped in an `<a href>` (click → product page / cart / etc.) and the migrated Redo image block has no link attached.

## Root cause

[`src/parser/blocks/image.ts`](src/parser/blocks/image.ts) reads the image `src` but may not be looking up the chain for a wrapping `<a href>` tag, or it's looking but the link isn't being attached to the emitted block.

Possible patterns Charlie 1 Horse uses:
- `<a href="…"><img src="…"/></a>` (standard wrap)
- `<a href="…"><table><tr><td><img …/></td></tr></table></a>` (table-wrapped)
- `<td><a href="…"><img …/></a></td>` (wrap inside the cell)

The parser likely handles one but not all. Charlie may use the variant that's missed.

## Proposed change

1. Pull source HTML for one or two templates (RYhKut + WgXbn6 are good representatives — RYhKut has multiple image-link instances; WgXbn6 is an AC email with a different image type).
2. Identify the DOM pattern Klaviyo uses for image+link in Charlie's templates.
3. In `image.ts`, walk parents of the `<img>` element looking for the nearest enclosing `<a href>` and attach its href to the emitted image block. Treat the href as a link that should go through `mapKlaviyoLink` from `url-mapping.ts` (same way buttons + Task 3's inline anchors do) so Klaviyo variables get rewritten.
4. Don't add the link if there's no `<a>` ancestor — keep the no-link case as-is.

## Verify

- Re-parse a Charlie 1 Horse template with image-links: emitted image block has a non-null `link` / `href` field populated with the rewritten URL
- Smoke test ([`src/parser/blocks/`](src/parser/blocks/) tests or extend `url-mapping.smoke.ts`) covers the image-with-anchor case
- Regression: images that DIDN'T have links don't suddenly get spurious ones; batch-test passes

## Notes

- Coordinate with Task 3 (inline anchor URL rewrite). Both tasks need `mapKlaviyoLink` to be called from new places. They can land independently; just both call into the same existing helper.
- WgXbn6 mentions "Product image does not give room for individual cart selection" — that's Task 2 (dynamic cart-items), separate from the missing-link issue here. The AC email may have BOTH issues on the same image block.

## Notes — executor investigation 2026-05-26

**Task premise doesn't match the parse output.** Surveyed every `<img>` in
every Charlie 1 Horse template against the current parser (PRs #75/#76/#77
merged). Comparison of source HTML ↔ parse output:

| Template | imgs in source w/ `<a href>` | clickthroughUrl set in parse output |
|----------|------------------------------|-------------------------------------|
| RYhKut   | 4 (logo + 3 product cards)   | 4 ✓                                  |
| WeieJr   | 2 (logo ×2)                  | 2 ✓                                  |
| SxWYeY   | 2 (logo ×2)                  | 2 ✓                                  |
| WgXbn6   | 1 (logo)                     | 1 ✓                                  |
| U3cE5u   | 1 (logo)                     | 1 ✓                                  |
| VRDxJu   | 2 (logo ×2)                  | 2 ✓                                  |

**Every image that has a wrapping `<a href>` in the source HTML gets its
`clickthroughUrl` correctly set in the parse output.** The image-parser
path (`$td.find(".kl-img-link")` →
[`image.ts:25`](../../../src/parser/blocks/image.ts#L25)) already handles
Charlie's HTML shape — `<a class="kl-img-link" href="…"><img/></a>`
nested inside `td.kl-image`.

**Images the merchant might be complaining about that DON'T have links:**

- `00b4ec2b-…gif` — decorative gif, appears once per template (between
  body text and footer). Has no `<a>` wrapper in the Klaviyo source —
  the merchant authored it without a link.
- `cec8a835-…jpeg` (SxWYeY only) — same shape; no `<a>` in source.
- `53db5161-…gif` (WeieJr only) — same.

The parser cannot invent links the source doesn't have.

**What might be the actual issue (downstream of mime):**

- The pre-#75 bundle had every image duplicated (desktop + mobile-only
  variant). The mobile variant's wrapper STILL has the same `kl-img-link`
  anchor in source HTML, so both variants would have emitted with
  clickthrough — the duplication itself doesn't explain "no link".
- Possible Redo-side issues:
  - Importer may not be persisting `clickthroughUrl` on `ImageBlock` when
    `clickthroughLinkType` is omitted (parser leaves it undefined per
    the schema comment "Omit to inherit the legacy 'web-page' behavior"
    at [`types.ts:210`](../../../src/renderer/types.ts#L210)).
  - Redo's editor preview may not render image hyperlinks as clickable,
    leading the merchant to assume they're missing.

**Recommended next step:**

Re-import Charlie 1 Horse post-#75 merge and inspect the imported
template's image blocks via Redo's API or editor — does the
`clickthroughUrl` field actually round-trip? If yes, the merchant
complaint is a UI-perception issue. If no, the importer needs an audit.

Marking `blocked` — the parser fix the planner anticipated isn't needed;
the right move depends on what the post-merge re-import shows.

## Done

(filled by executor on completion)

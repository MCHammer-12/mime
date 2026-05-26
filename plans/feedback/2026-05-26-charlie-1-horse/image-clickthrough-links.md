---
status: unclaimed
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

## Done

(filled by executor on completion)

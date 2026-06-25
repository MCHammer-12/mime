---
status: done
branch: fix/tbn-heading-bold-dropped
pr: 137
---

# Heading bold dropped ("Make Your Dumb Trolling Motor...SMART")

## Feedback (verbatim)

Tiny Boat (AutoBoat, R3rU5j), Michael: "'Make Your Dumb Trolling Motor...SMART' was bolded in Klaviyo, do we have a way to copy bolding and apply it?"

## Root cause (from bundle)

The text is an `<h2>`:
```html
<h2 style="text-align: center;"><span style="font-size: 24px;">Make Your Dumb Trolling Motor...SMART</span></h2>
```
Klaviyo's stylesheet makes headings bold: `h2 { … font-weight: bold; … }`. The bold is **implied by the `<h2>` tag + the embedded `<style>`**, NOT an inline `font-weight` on the span. When mime flattens the heading to a Redo text block, it reads inline styles (the span's `font-size:24px`) but doesn't apply the **tag-level default weight** from the document's `h1..h4` CSS → bold lost.

Files: [`src/parser/blocks/text.ts`](../../../src/parser/blocks/text.ts) (heading flatten), [`src/parser/style-utils.ts`](../../../src/parser/style-utils.ts). Klaviyo's heading CSS (h1=normal, h2/h3=bold, h4=400) is in every template's `<head>` `<style>`.

## Proposed change

When converting an `<h1>..<h4>` to a text block, apply the heading's default weight from Klaviyo's stock heading CSS (h2/h3 → bold; h1/h4 → normal/400) unless an inline `font-weight` overrides it. Keep it to the stock heading weights (they're consistent across Klaviyo exports — confirm against the `<style>` block rather than hardcoding if cheap). Same logic likely applies to heading default font-size/color if those are also being lost (check).

## Verify
- AutoBoat re-parsed: the "...SMART" h2 text block is bold.
- Regression: non-heading text + explicitly-non-bold headings unaffected; batch-test 416/0. Add a smoke for h2→bold, h4→normal.

## Notes
- Routes to Content cluster (D). Likely shares a fix surface with any "heading styling lost" reports.

## Done
**Shipped — PR #137.** mime was already preserving the `<h2>` tag (verified: the
output kept `<h2><span style="font-size:24px">Make Your Dumb Trolling Motor...SMART</span></h2>`),
but Redo's text editor doesn't apply the heading-tag default weight, so the bold
was lost. Fix: new `applyHeadingWeight` transform in `text.ts` wraps `<h2>`/`<h3>`
content in `<strong>` (Klaviyo's stock bold headings; h1/h4 stay normal), unless
an inline `font-weight` already decides it. Verified on the real R3rU5j template
(heading now `<h2><strong><span…`); new `heading-weight.smoke` 5/5; batch
416/0-failed; 0 new tsc errors.

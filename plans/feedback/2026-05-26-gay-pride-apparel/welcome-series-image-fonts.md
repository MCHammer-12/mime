---
status: unclaimed
branch: fix/welcome-series-image-fonts
pr: null
---

# Welcome Series Email 1 — image fonts inaccurate or missing

## Feedback (verbatim)

LdZngk (Welcome Series), about Email 1 ("Discount Inside! Welcome to the GPA Fam!"):

> for the first welcome series flow (Discount Inside! Welcome to the GPA Fam!) the image that created did not have the accurate font some did not have font at all.

## Root cause

The wording is ambiguous — "the image that created" could mean:

1. **Image block with text drawn into it (rasterized text-on-image).** A Klaviyo hero image where text is baked into the PNG by the merchant. mime doesn't generate these; they're static assets. If wrong fonts, the merchant's Klaviyo asset itself has them. Not a mime bug.
2. **Image-with-overlay-text component** in Klaviyo's block editor (text rendered as HTML over an image). Migrated to Redo, the overlay text picks up wrong font because either:
   - The font wasn't extracted from the overlay block specifically
   - The brand kit doesn't have that font (same surface as Blackline's task)
3. **"Image" used loosely to mean "the rendering of the email"** — i.e. the executor opens the Redo email preview and the fonts look wrong. This is the same surface as Blackline's font-rendering-inconsistent task.
4. **Server-side rasterization of email preview** — mime renders the email via MJML + Playwright for the side-by-side viewer. If that server-side render lacks the right fonts, the screenshots come out wrong. Unlikely to be what the merchant means (they're using the Redo editor, not mime's viewer).

## Proposed change

This needs investigation before any code change. Steps:

1. **Fetch the source HTML** for the first Welcome Series email via Klaviyo API (key provided by Michael; don't commit). The flow's first `send_email` step is action `5633518` with `templateId: __PLACEHOLDER_WyBhAb__`. Need the Klaviyo template ID for that placeholder — pull it from the source flow JSON or via Klaviyo's flow detail endpoint.
2. **Determine the case** (1-4 above). The simplest check: open GPA's Welcome 1 email in the Redo editor and inspect the block types. If the "image" is literally a `<img>` block with baked-in text, that's Case 1 (not actionable). If it's a Klaviyo image-with-overlay-text block, that's Case 2. If the email is HTML text but renders wrong, that's Case 3 (collapse into Blackline's task).
3. Update this task file with the finding. Then either:
   - **Case 1:** Mark `dropped` — merchant's asset issue
   - **Case 2:** Patch the overlay-text font extraction in [`src/parser/blocks/klaviyo-specific.ts`](src/parser/blocks/klaviyo-specific.ts) or wherever image-with-overlay-text is handled
   - **Case 3:** Mark `blocked`, link to Blackline's [`font-rendering-inconsistent`](../2026-05-26-blackline-car-care/font-rendering-inconsistent.md), let that PR cover both merchants

Relevant files:
- [`src/parser/blocks/image.ts`](src/parser/blocks/image.ts) — image block parser
- [`src/parser/blocks/klaviyo-specific.ts`](src/parser/blocks/klaviyo-specific.ts) — Klaviyo-specific blocks including image-with-text variants
- [`src/fonts.ts`](src/fonts.ts) — font pipeline (Blackline-shared area)

## Verify

- Identify the case and document in this task file
- For Case 2: re-import GPA Welcome 1; overlay text renders with the correct font
- For Case 3: verify in conjunction with Blackline's task — both merchants should resolve from the same fix
- No regression on other merchants' welcome flows (batch-test)

## Notes

- **Strong likelihood this is Case 3** (same as Blackline) — the merchant's phrasing matches Blackline's "fonts being weird" complaint. Triage quickly; if confirmed Case 3, defer to Blackline's task and close this as resolved-by.
- If Case 1: surface to Michael — merchant may want to know that their Klaviyo asset has rasterized text and won't migrate cleanly going forward. Could be added to a "things merchants need to know pre-migration" doc.
- The Welcome Series flow has 6 emails total. The feedback only mentions Email 1. Don't expand scope to other emails unless investigation shows the same bug recurring.

## Done

(filled by executor on completion)

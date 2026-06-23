---
status: unclaimed
branch: fix/universal-content-blocks
pr: null
---

# Klaviyo universal (saved/shared) content blocks not migrated

## Feedback (verbatim)

Blackline Car Care `Viewed Product - (KLAYVIO)` flow (RbNxkM), Michael (2026-06-16): "The universal blocks were not successfully migrated so I had to manually put them in redo."

## What this is

Klaviyo **universal content blocks** (a.k.a. saved/shared blocks) are reusable blocks — typically headers, footers, promo banners — defined once and embedded across many templates; editing the universal block updates it everywhere. When a template using one is migrated, the universal block's content isn't carrying into Redo (dropped or mangled), so the operator rebuilds it by hand.

## Root cause — investigation-first (not yet diagnosed)

**This flow bundle has no template HTML** (it references templates by ID; `klaviyo-flow.json` has no inlined markup and no `universal`/`content_block` markers). So the universal-block markup isn't visible here — diagnosis needs the actual template HTML.

How Klaviyo renders universal blocks at export is the unknown: they're usually inlined into the template HTML but may carry a distinguishing wrapper (`data-block-id`, a `kl-universal*` class, or a saved-block component wrapper). mime's dispatcher likely doesn't recognize that wrapper → drops or flattens it.

Likely files once the markup is known: [`src/parser/index.ts`](../../../src/parser/index.ts) (dispatcher), [`src/parser/blocks/klaviyo-specific.ts`](../../../src/parser/blocks/klaviyo-specific.ts) (Klaviyo-specific block wrappers).

## Proposed change

1. **Get the markup.** Fetch a Blackline template that uses a universal block — via the richer template-bundle format (`klaviyo-source.html` + `redo-output.json`) or `/api/debug/resolve-template` / Klaviyo API (key from Michael). Identify the universal-block wrapper (class / data attribute / component shape).
2. **Decide handling:**
   - If the universal block's inner content is standard kl-* blocks wrapped in a universal container → the fix is to **descend into the wrapper and parse its children** (don't treat the wrapper as an unknown/opaque block).
   - If it's an opaque saved-block reference (content not inlined) → mime must resolve it (Klaviyo saved-block API) before parsing, or warn precisely that a universal block couldn't be expanded.
3. Emit the contained blocks into Redo normally (Redo has no "universal/shared block" concept — they become regular blocks in each template; that's expected and fine).
4. Smoke fixture from the real universal-block markup.

## Verify

- A Blackline template with a universal block re-parsed: the block's content (header/footer/banner) appears in the Redo output, not dropped.
- Regression: templates without universal blocks unchanged; batch-test 416/0.

## Notes

- **Cross-merchant** — universal/saved blocks are a common Klaviyo feature; any merchant using them hits this. Routes to **Content cluster (D)**.
- Surfaced alongside the timeframe-rounding task in the same Blackline bundle (2026-06-16), but unrelated — that one is flow timeframes, this is template content.
- Don't conflate with the CODE-template work (`editor_type: CODE`) — universal blocks appear in normal block-editor templates too.

## Done
(filled by executor)

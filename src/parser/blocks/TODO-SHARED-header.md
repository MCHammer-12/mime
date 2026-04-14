# Header block: session wrap-up & follow-up work

Completed: `parseHeaderBlock` now emits `ImageBlock` for the logo portion (not `HeaderBlock`) per DECISIONS.md 2026-04-14 — Redo's native HeaderBlock auto-pulls logo from brand kit which is unreliable for migrations. Logo width preserved via calculated horizontal inner padding so a 300px Klaviyo logo renders at ~300px in the 600px Redo email. Alignment read from `.hlb-logo` TD's `align` attribute.

---

## PRIORITY 1: Rename function

`parseHeaderBlock` function name is now misleading — it produces ImageBlocks, not HeaderBlocks. Kept because `src/parser/index.ts` is frozen during parallel work.

**Action when freeze lifts:** rename to `parseHeaderLogoAsImage`. Update dispatcher reference.

---

## PRIORITY 2: Delete dead `src/renderer/blocks/header.tsx`

Now that no Klaviyo templates emit `HeaderBlock`, the renderer component is dead code for migration output. It's still wired in `componentMap` and would only fire if someone hand-constructs a `HeaderBlock` in test data.

**Action when shared files unfreeze:** delete `src/renderer/blocks/header.tsx`, remove from `componentMap`. Or leave it in place if we want the renderer to support HeaderBlocks for non-migration scenarios.

---

## PRIORITY 3: Non-HLB logo detection

~35 templates in the corpus (cart-discount, checkout-discount, etc.) use plain `kl-image` blocks for logos — not `hlb-wrapper`. Those go through the regular image parser and render as normal images. Visually fine, but the merchant might want them semantically tagged as "header" for some future automation.

**Options:**
- **Heuristic** — first image with "logo" in alt text, or first image within the first 100px of the template → treat as header. Fragile.
- **Ignore** — let them be regular images. Recommended.

Low priority; revisit only if there's a product need.

---

## Cross-cutting

### Width preservation math mirrors image.ts

Header uses `(EMAIL_MAX_WIDTH_PX - sectionPadding.left - sectionPadding.right - logoWidth) / 2` for inner padding; image.ts uses the same pattern. Keep these in sync if either changes (e.g. if email max width becomes configurable).

### Menu separation

Menu items within an HLB are extracted separately by `parseMenuFromHeader` in `menu.ts`. Keep that boundary — header.ts does logo only, menu.ts does nav.

---
status: blocked
branch: fix/link-color-investigate
pr: null
blocked-on: Redo-side — not a mime bug (see triage 2026-06-25)
---

# Link text color shows red in Redo, blue in Klaviyo — investigate where the override comes from

## Feedback (verbatim)

Tiny Boat (AutoBoat, R3rU5j), Michael: "the linked text color in Klaviyo is the normal blue while in Redo it is red. Are we able to copy that over?"

## Root cause — partially diagnosed (NOT a parser bug)

**mime preserves the inline anchor colors correctly.** Confirmed from `redo-output.json`: the text blocks' anchors retain `color: #15c` (Klaviyo blue) ×2 and `color: rgb(248,1,1)` (the red "TOMORROW" link) — exactly as in source. So the parser is not mangling link color.

The red the merchant sees in the Redo editor must come from a **template/brand-kit-level link color override**, not the inline span. Two candidates:
1. mime sets template `linkColor: #0000ee` (Redo default blue) — confirmed in output. If Redo's editor renders all anchors using `template.linkColor`, links would show `#0000ee` (blue), not red — so this alone doesn't explain red.
2. The team's **brand-kit link color** (or an editor theme) is red and overrides inline colors at render time.

So the investigation question: **does Redo's email editor honor inline anchor `color`, or force the template/brand-kit link color?** That determines the fix.

## Proposed change (investigate first)

1. Open the AutoBoat email in the Redo editor on the Tiny Boat team. Inspect a link that's blue in Klaviyo — is it red because of (a) the brand-kit link color, (b) `template.linkColor`, or (c) something stripping the inline color on import?
2. Confirm via redoapp whether the editor renders anchors with inline `color` or with the template/brand-kit link color. Use the Redo MCP / `email-template.ts` `linkColor` semantics.
3. Fix per finding:
   - If editor forces `template.linkColor`: set it to Klaviyo's dominant link color (here `#15c` blue) instead of `#0000ee` default, and/or carry per-link colors if the schema supports them.
   - If brand-kit link color overrides: that's a merchant brand-kit setting, not a migration bug — surface a note, don't "fix" in the parser.

## Verify
- AutoBoat in Redo editor: blue Klaviyo links render blue (not red).
- Regression: emails without special link colors unaffected.

## Notes
- **Don't assume a parser fix** — the inline colors are already correct. The lever is template `linkColor` / brand-kit, or Redo editor rendering. Confirm before changing anything.
- Routes to Content cluster (D) — but may resolve as "brand-kit setting, not a bug."

## Done

**BLOCKED — not a mime bug (re-confirmed 2026-06-26).** Verified against
R3rU5j's `redo-output.json`: mime preserves every inline anchor color exactly
(`#15c` blue ×2, `rgb(248,1,1)` red), and `text.ts` `applyContrastFloor` can
only ever return the original color or black/white — it is structurally
incapable of producing red. The red is a Redo email-editor render question
(does it honor per-block/inline anchor `color`, or force template/brand-kit
`linkColor`), answerable only in the live editor on the Tiny Boat team. No
mime change available. Next step is a redoapp/editor investigation — see below.

## Executor triage 2026-06-25
NOT A MIME BUG. Confirmed mime preserves the inline anchor colors exactly
(`#15c` blue ×2, `rgb(248,1,1)` red). The red the merchant sees is a Redo
editor/brand-kit link-color render question, not parser output. Resolve by
checking whether Redo's email editor honors inline anchor `color` or forces
`template.linkColor`/brand-kit — a redoapp investigation, not a mime change.

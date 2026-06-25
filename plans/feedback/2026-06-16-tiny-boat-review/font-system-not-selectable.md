---
status: unclaimed
branch: fix/font-system-not-selectable
pr: null
---

# Font set but "not selected" in editor — system font (Helvetica Neue) not in brand kit

## Feedback (verbatim)

Tiny Boat (AutoBoat, R3rU5j), Michael: "The font wasn't applied. It's one of the font options but didn't seem to be selected. this is a recurring issue that we need to keep looking into."

## Root cause — diagnosed

mime **did** set the font: `redo-output.json` text blocks carry `fontFamily: "Helvetica Neue"`, and `_fontPlan` is empty/`hasUnresolved:false` (nothing flagged). So the value is there.

The problem: **"Helvetica Neue" is a system font, not a brand-kit/Google font.** Redo's editor font dropdown is populated from brand-kit + supported fonts; a system font set on the block isn't an option in that list, so the editor shows the block as having no font *selected* even though it renders. This is the recurring "font option exists but not selected" pattern (distinct from the #111 name-mismatch case — here the font genuinely isn't a selectable option).

Files: [`src/parser/blocks/text.ts`](../../../src/parser/blocks/text.ts) (font extraction), [`src/fonts.ts`](../../../src/fonts.ts), font preflight in [`src/migrate/server.ts`](../../../src/migrate/server.ts) / [`import-rpc.ts`](../../../src/migrate/import-rpc.ts). Related: memory `project_custom_font_issue`, font-mapping #111.

## Proposed change (planner recommendation — confirm approach)

The fix is to make the system font a **selectable** option, one of:
1. **Map common system fonts → nearest supported/brand-kit font** at parse (Helvetica Neue → Helvetica/Arial if those are selectable, or the brand-kit body font). Deterministic, no prompts.
2. **Surface system fonts in the preflight** like custom fonts (#111 flow), so the operator maps them to a brand-kit choice.
3. **Auto-add common system fonts to the brand kit** as part of import.

Likely (1) for the truly-generic system stack (Helvetica Neue, Arial, Georgia, etc.) with a fallback to the preflight picker when ambiguous. **Confirm with Michael which** — this is the "recurring issue" he wants a real answer on, so the cluster owner should decide the policy, not patch one font.

## Verify
- AutoBoat re-imported: the text blocks show a *selected* font in the Redo editor (mapped or added), rendering as intended.
- Regression: brand-kit + Google fonts unaffected; #111 name-mapping path intact.

## Notes
- **This is the Fonts-cluster (C) keystone** — Michael has flagged "font not applied / not selected" across many merchants. Resolve the system-font selectability policy here and it likely clears a big chunk of the cluster. Coordinate with #111 (name reconciliation) — complementary, not duplicate.

## Done
(filled by executor)

## Executor triage 2026-06-25
NEEDS A DECISION (not a clean parser fix). mime correctly SET the font
(`fontFamily: "Helvetica Neue"`); the problem is it's a system font, not a
brand-kit/Google option, so Redo's editor shows no selection. Options: (a) map
common system fonts → a Redo-supported equivalent at parse time, (b) add them to
the brand kit during preflight, (c) leave as-is (renders fine, just not
editor-selectable). Pick one before coding — same family as #111 font work.

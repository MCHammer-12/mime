---
status: done
branch: fix/font-name-mismatch-mapping
pr: https://github.com/MCHammer-12/mime/pull/111
---

# Font preflight: let operator map Klaviyo font → brand-kit font after adding

## Feedback (verbatim)

Michael, 2026-05-26:

> In some cases where we go and add a font because it's not added yet, usually the font name isn't the exact same as what was imported. The font name in Klaviyo isn't the exact same as what we import. There should be a way that if we add the font, then we should be able to select that from the options. Instead of "Continue adding them", it would say "Select imported font" or something like that.

## Root cause — confirmed by code read

The font preflight gate uses **exact lowercase name matching**, so a font the operator genuinely added doesn't get recognized (or doesn't render) when Redo's brand-kit name differs from Klaviyo's.

**Where it breaks — [`filterFontsNotInBrandKit`](../../../src/migrate/import-rpc.ts) (import-rpc.ts:307-323):**

```js
const existing = new Set(
  currentFamilies.map((f) => String(f.fontFamily ?? "").toLowerCase()),
);
return unresolved.filter((u) => !existing.has(u.family.toLowerCase()));
```

Klaviyo template references `"Futura"`. Operator uploads the font to Redo; Redo's `processFontFiles` names the family from the font file's internal name — e.g. `"Futura PT"`, `"FuturaStd-Medium"`, `"Century Gothic"`. The exact-match `existing.has("futura")` is **false**, so:

1. The preflight modal keeps insisting the font is "still missing" even after the operator added it, AND
2. Even if waved through, the imported template still references `"Futura"` — which doesn't match brand-kit `"Futura PT"` — so it falls back to generic sans/serif at render. (This is exactly Blackline's + the cross-merchant font complaint, partially.)

**Current modal — [`preflightUnresolvedFonts`](../../../src/migrate/server.ts) (server.ts:1119-1175):** a single boolean prompt:

```js
trueLabel: "Continue (added them)",
falseLabel: "Import anyway",
```

It assumes the name matches after adding. It doesn't reconcile the name difference.

## Proposed change

Turn the single boolean into a **two-step flow**, then **rewrite the template's font references** to the chosen brand-kit name.

**The infra already exists** — `PendingInput` ([jobs.ts:53-80](../../../src/migrate/jobs.ts)) supports `type: "choice"` with `options: PendingInputOption[] ({value,label})`. The flow-trigger picker ([server.ts:1341](../../../src/migrate/server.ts)) is the reference pattern. No new modal type needed; the UI (`mock-stream.js` + modal component) already renders `choice`.

### Step 1 — "I've added them" (existing boolean, lightly reworded)
Keep the existing prompt that tells the operator to add the fonts to the brand kit. On confirm, proceed to step 2 instead of assuming a name match.

### Step 2 — map each unresolved Klaviyo font to a brand-kit font (NEW)
1. Re-fetch the brand kit (reuse `getTeam` from import-rpc — already called inside `filterFontsNotInBrandKit`; expose a sibling that returns the full `customFontFamilies` list, not just the filtered-missing set).
2. **Auto-match first (avoid over-prompting).** For each unresolved Klaviyo font, try to resolve it against the brand-kit families with normalization:
   - exact (case-insensitive) — already works, won't reach here
   - normalized: strip spaces, weight suffixes (`Thin|Light|Regular|Medium|SemiBold|Bold|Black`), foundry suffixes (`PT`, `Std`, `MT`), lowercase — `"Futura"` ≈ `"Futura PT"`, `"futurastd"`
   - prefix/contains either direction
   - If exactly one confident match → use it silently, emit an info log. Only ambiguous / no-match fonts reach the prompt.
3. For each font still needing a decision, emit ONE `choice` prompt:
   - `question`: `Klaviyo font "Futura" — which brand-kit font did you add for it?`
   - `options`: every brand-kit `customFontFamilies[].fontFamily` as `{value, label}`, PLUS a `{value: "__fallback__", label: "Leave as-is (generic fallback)"}` escape hatch
   - `questionKey`: `font-map:${klaviyoFamily.toLowerCase()}` (per-font, so the answer caches within the job if the same font recurs across templates)
   - `itemLabel`: the Klaviyo font name
4. Record the mapping `klaviyoName → redoBrandKitName` (skip entries mapped to `__fallback__`).

### Step 3 — rewrite template font references (NEW)
Before `createEmailTemplate`, walk each exported template JSON and rewrite block-level `fontFamily` strings from the Klaviyo name to the mapped brand-kit name. Source of the field: [`text.ts:584`](../../../src/parser/blocks/text.ts) emits `fontFamily` at block level (Redo's Quill whitelists block-level `fontFamily` only — see text.ts:532 comment). A small helper that recurses the template JSON `blocks[]` and replaces `fontFamily === klaviyoName` with the mapped name. Apply the same mapping to any brand-kit-level default font references if present (`settings.brandKit.font.*` — confirm shape).

## Verify

- Re-import a template that uses a non-Google font (e.g. Blackline's Futura, or Charlie's Century Gothic Charlie):
  - operator adds the font to brand kit (named differently)
  - preflight step 2 prompts to map it; operator picks the brand-kit font
  - imported template's text blocks reference the brand-kit name and render in the correct font (no serif fallback)
- Auto-match path: a font where Klaviyo "Futura" and brand-kit "Futura PT" differ only by suffix resolves WITHOUT a prompt (info log instead)
- Fallback path: operator picks "Leave as-is" → template keeps the Klaviyo name, behavior unchanged from today (no regression)
- Smoke test: a unit test on the normalization/auto-match helper covering exact, suffix, prefix, no-match cases
- Regression: a template whose fonts ARE all in the brand kit by exact name skips both steps entirely (no new prompts)

## Notes

- **This is the constructive half of the cross-merchant font problem.** The font tasks (Charlie Task 4, Blackline, GPA Task 2) are about extraction + rendering; this is about the add-font reconciliation UX. They're complementary. Once this lands, the operator can actually make a non-Google font render end-to-end. Cross-link to Blackline's [`font-rendering-inconsistent`](../2026-05-26-blackline-car-care/font-rendering-inconsistent.md) — its FOUT/Arial-mix symptom may partly be this name mismatch.
- **Don't add new prompt machinery** — `type: "choice"` is enough. Resist building a multi-select "map all at once" UI; the per-font loop with answer-caching is simpler and reuses the existing modal. If Michael later wants a single combined mapping screen, that's a UI follow-up.
- **Keep the auto-match conservative.** A wrong silent auto-map is worse than a prompt — if normalization yields ≥2 candidate brand-kit fonts, prompt; don't guess. Log every auto-match so it's auditable in the import stream.
- **`questionKey` caching:** per-font key means if 5 templates in the batch all use "Futura", the operator maps it once. Mirrors how the existing font-preflight `fontKey` and flow-trigger `flow-trigger:${flowId}` keys work.
- Bump the UI script `?v=N` cache-buster in [`src/migrate/ui/index.html`](../../../src/migrate/ui/index.html) if a UI component changes (per project CLAUDE.md). If only server logic changes (the modal already supports `choice`), no bump needed.

## Done

- PR: https://github.com/MCHammer-12/mime/pull/111
- Implemented the two-step flow + template rewrite exactly as proposed:
  - **Step 1** (reworded): the existing boolean "added them?" prompt, now
    telling the operator the name doesn't have to match exactly.
  - **Step 2** (new): re-fetch the brand kit
    ([`getBrandKitFontFamilies`](../../../src/migrate/import-rpc.ts) — new
    sibling to `filterFontsNotInBrandKit`), auto-match each still-missing
    font, prompt per-font only when ambiguous/no-match via the existing
    `type: "choice"` modal. Per-font `questionKey` caches the answer.
  - **Step 3** (new): `rewriteTemplateFontFamilies` repoints block-level
    `fontFamily` to the chosen brand-kit name before import — applied in
    BOTH the template phase AND the flow phase (flow placeholder templates
    are the same object refs `importFlowRpc` consumes, so in-place rewrite
    reaches the flow emails).
- New helpers in [`src/fonts.ts`](../../../src/fonts.ts):
  - `normalizeForFontMatch` — tokenize + drop weight/foundry tokens for
    comparison. Futura / Futura PT / FuturaStd-Medium all → "futura".
  - `matchFontToBrandKit` — 3 tiers (exact / normalized-eq / length-guarded
    containment). Conservative: ≥2 candidates → ambiguous (prompt), never
    silently guesses wrong.
  - `rewriteTemplateFontFamilies` — generic walk over the template JSON;
    catches text/menu/button/products + nested column cells. WeakSet guard.
- **No new prompt machinery / no UI cache-buster bump** — reuses the
  existing `PendingInput` `choice` type (same as the flow-trigger picker).
  Confirmed `mock-stream.js` already renders `input.options`.
- **Auto-match is conservative** per the task's guidance: a code-review
  pass caught a Tier-3 containment false-positive (a short generic
  residual like "PT Sans" → "sans" could match an unrelated font) — fixed
  with a min-length/ratio guard + a regression smoke case.
- Verification: 14 `fonts.smoke.ts` cases; end-to-end (real export →
  inject "Futura" → match "Futura PT" → rewrite → block references
  "Futura PT"); batch-test 416 templates 0 failures; flow/condition smoke
  unchanged; `tsc` 0 errors in touched files.
- **Pending:** live re-import for a real non-Google-font merchant
  (Blackline's Futura, Charlie's Century Gothic Charlie) to confirm the
  font renders correctly in the Redo editor end-to-end.
- **Scope note:** brand-kit-LEVEL default font references
  (`settings.brandKit.font.*`) aren't in the exported template JSON (the
  brand kit is team-level, separate), so there's nothing to rewrite there
  — the per-block walk covers everything the template carries.

## Done

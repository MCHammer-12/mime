---
status: blocked
branch: fix/eg-templates-blank-emails
pr: null
---

**Status note (2026-05-26):** Michael chose Option C — fix CODE parser fidelity first, then ungate. This task is blocked pending a separate "CODE parser fidelity" planning batch covering image widths, column gaps, and per-span text styling (the open items in memory `project_code_template_parser`). Castle Sports' 3 abandonment flows remain unusable until that batch ships.


# `[EG]` templates produce blank emails across 3 flows

## Feedback (verbatim)

Castle Sports flagged 3 flows:

- WrazNX `[EG] Browse Abandonment Flow`: "Non of the Emails had images"
- Xm2TP7 `[EG] Checkout Abandonment Flow`: "Non of the Emails had images"
- R9iyHp `[EG] Checkout Abandonment Flow [No Discount Code]`: "Non of emails had images"

## Root cause — CONFIRMED

**The blank-template templates are `editor_type: CODE`.** Verified live via Klaviyo API during planning:

- Xm2TP7 (`[EG] Checkout Abandonment Flow`) Email 1 → template `RYCBtZ` → `editor_type: CODE` (HTML ~440KB)
- UQJH6z (`[EG] Post Purchase Flow`) Email 1 → template `RUpF6R` → `editor_type: SYSTEM_DRAGGABLE` (parses normally — see Tasks 2 + 3 for its issues)

So the `[EG]` prefix is a red herring. The real differentiator is `editor_type`. CODE templates fall through mime's existing CODE-template gate to blank output.

**Per memory `project_code_template_parser`:** mime has a CODE-template parser at [`src/parser/code-template.ts`](src/parser/code-template.ts) (built 2026-04-20) that handles both table-based + div-based dialects. Tested on Otishi: 368/368 parse with 0 failures. Block detection works. **But visual fidelity in the Redo builder was deemed insufficient to ship** — image widths, column gaps, and per-span text styling are wrong. The parser was gated off behind an `editor_type: CODE` / no-kl-class heuristic, intentionally inert for block-editor migrations.

Castle Sports just made CODE migration a real blocker — 3 of their abandonment flows are unusable in Redo until something changes.

The merchant says "no images" because the entire email is empty content (parse-result.blankTemplateCount confirms): WrazNX has 2 blank, Xm2TP7 has 5 blank, R9iyHp likely similar.

Relevant files:
- [`src/parser/code-template.ts`](src/parser/code-template.ts) — the gated CODE parser (table-based + div-based)
- [`src/parser/code-template-{smoke,warnings,debug,emit}.ts`](src/parser/) — batch harnesses
- [`src/parser/index.ts`](src/parser/index.ts) — dispatcher; check the editor_type gate
- [`src/migrate/template-resolver.ts`](src/migrate/template-resolver.ts) — resolver failure modes (`ResolveFailure` variants)

## Proposed change — needs Michael's decision before executor codes

Three options, ranked by my read of cost/benefit:

**Option A: Ship the CODE parser as-is, accept fidelity gaps.**
- Remove the gate in [`src/parser/index.ts`](src/parser/index.ts). CODE templates now flow through `code-template.ts`.
- Surface the known fidelity issues (image widths, column gaps, per-span text styling) as a `templateWarning` so the operator + merchant know to review.
- Pro: Castle's abandonment flows become usable today.
- Pro: 0 risk to existing block-editor migrations (still go through the main parser).
- Con: Merchants will see imperfect rendering in the Redo editor and may flag follow-up bugs.

**Option B: Clear preflight warning, no parser change.**
- Detect `editor_type: CODE` in [`template-resolver.ts`](src/migrate/template-resolver.ts) and emit a typed `ResolveFailure` (e.g. `unsupported-editor-type`).
- Surface in the preflight modal so the operator chooses to skip or proceed-with-blank.
- Pro: Honest about what mime can't do.
- Con: Castle Sports still can't migrate these flows — net no progress for the merchant.

**Option C: Fix CODE parser fidelity first.**
- Image width extraction, column gap handling, per-span text styling — the open items in `project_code_template_parser` memory.
- Then ship + ungate.
- Pro: Best end-state.
- Con: Largest investment; Castle is blocked until it lands.

**My recommendation: Option A.** Castle Sports has 5+ unusable emails right now. Imperfect rendering + a "review me" warning beats silent blank. The fidelity issues can ship as follow-up tasks once we see what merchants actually flag in real usage.

**Executor steps once Michael picks:**

For Option A:
1. Read [`src/parser/index.ts`](src/parser/index.ts) — find the `editor_type` gate that currently routes CODE to no-op
2. Replace with call into [`src/parser/code-template.ts`](src/parser/code-template.ts) (the existing parser)
3. Add a `templateWarning` emission with a fixed message: "CODE-template parser is in beta — image widths, column gaps, and per-span text may render differently in Redo. Review each email after import."
4. Re-run [`src/parser/code-template-smoke.ts`](src/parser/) on the Otishi corpus to confirm no regression (368/368 should still pass)
5. Smoke test with one of Castle's templates via `/api/debug/resolve-template` or local cached HTML
6. Patch any new failures from Castle's specific markup

For Option B:
1. Add new `ResolveFailure` variant `unsupported-editor-type` to [`template-resolver.ts`](src/migrate/template-resolver.ts)
2. Wire to the preflight modal so operator chooses skip / proceed-with-blank
3. Ensure flow imports without crashing when blank is chosen

For Option C: separate planning task — too large for this batch.

## Verify

- One of the 3 affected flows reproduces locally with smoke-test on the source HTML
- Either the parser produces non-empty Section[] (if block-editor fix), OR the resolver returns a typed failure with a clear reason (if CODE / HTML)
- Re-import Castle Sports: either the emails have content, OR the operator gets a preflight modal explaining what's missing
- No regression on the historical corpus

## Notes

- **Decision needs Michael before code starts.** Pick Option A / B / C. My recommendation is A.
- Don't conflate with GPA Task 1 (`customer-thank-you-no-emails`). GPA's flow has `blankTemplateCount: 0` (placeholder rewrite/template-link issue) — different surface from Castle's `blankTemplateCount: 2-5` (CODE templates hit gate, produce empty Section[]).
- The 4th `[EG]` flow (`Post Purchase`, UQJH6z) is NOT in this task — its template is `SYSTEM_DRAGGABLE` (block-editor), parses to content. Tasks 2 + 3 cover that flow's separate content issues.
- The CODE parser was paused because of fidelity — not safety. Shipping it means existing block-editor merchants are unaffected (their templates take the block path); only CODE-using merchants newly get content (imperfect) instead of blank.
- Diagnosis was done live via Klaviyo API during planning; the Klaviyo key Michael provided for Castle Sports was used to fetch templates `RYCBtZ` (CODE, blank case) and `RUpF6R` (SYSTEM_DRAGGABLE, non-blank case). The key isn't persisted in any file.

## Done

(filled by executor on completion)

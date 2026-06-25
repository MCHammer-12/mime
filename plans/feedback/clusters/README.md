# Engineering clusters — consolidated backlog

Created 2026-06-12. Michael's call: pause per-merchant planning, batch the
~30 per-merchant tasks into engineering clusters so executors work a cluster
end-to-end instead of ping-ponging across merchant dirs.

This board **groups + sequences + links**. The granular detail stays in the
per-merchant task files; this is the map. Status reflects best knowledge as
of 2026-06-12 (some task files live on unmerged PRs — noted).

## How to use
- Pick a cluster, work its open items top-to-bottom, update the underlying
  task files' status as you go (per `../README.md` executor rules).
- "Decision" rows are settled — don't re-litigate (memories
  `feedback_migration_decisions`, `feedback_segment_import_decision`).

---

## A. Conditions & Segments — highest leverage, mostly shipped
The "looks-successful-but-wrong" family: splits that migrated with empty/wrong predicates.

| Item | Status | Where |
|------|--------|-------|
| Metric VALUE → whereCondition (not count) | ✅ shipped | ad-hoc #110 |
| phone-country → native `country` dimension | ✅ shipped | Yes Homo #93 |
| profile-property `contains`/`is-set` + trigger-split list filters | ✅ shipped | Tiny Boat #116 |
| Segment auto-creation (tags / list-update / rule-based) | ⬜ buildable now | ad-hoc Task 4 |
| Static-list-membership **condition** | ⏸ deferred — needs redoapp add-members RPC | SHOC Task 1 (PR #117) |
| Tag actions → `manage_customer_tags` | ⬜ buildable now (split from list half) | Tiny Boat Task 2 |
| Customer Thank You "no email" (placeholder bug, 2 merchants) | ⬜ open | GPA Task 1 (#78), Yes Homo collapse |

**Decision:** segments — ship buildable, defer member-copy. Customer/profile data is being pulled into Redo by a **separate effort Michael is building** → segment member-match + flow audiences will have data; Task 4's "members must exist" caveat is being addressed upstream.

**Sequence:** Task 4 buildable path → Tiny Boat 2 tag half → GPA placeholder bug. SHOC 1 waits on the add-members RPC.

---

## B. Triggers — small, high-impact, mostly decided
| Item | Status | Where |
|------|--------|-------|
| Date/birthday triggers 400 (emit `triggerSpecificFields:[BIRTHDAY]`; fail predictive gracefully) | ✅ shipped — date 400 fixed (birthday-on-day + warning + preflight guard); predictive-*condition* residual is a condition-mapping item | ad-hoc Task 3 |
| Started Checkout → **Checkout Abandonment** (reverse #43) | ⬜ open | ad-hoc Task 5 (PR #119) |
| Unknown custom-event metric → **always picker** (kill silent order_fulfilled mis-resolve) | ⬜ open | Rufskin Task 1 (PR #113-adjacent) |

**Decisions (all settled):** started-checkout→checkout abandonment; unknown metric→picker, never silent-default; date trigger→birthday-or-graceful-fail.

**Sequence:** these three are independent + ready — good first cluster to clear. All touch `trigger-mapping.ts` / picker; coordinate edits.

---

## C. Fonts — 6 merchants, mostly shipped; verify coverage
| Item | Status | Where |
|------|--------|-------|
| Klaviyo→brand-kit name reconciliation (map + rewrite) | ✅ shipped | ad-hoc #111 |
| First-text font-size/family | ✅ shipped | Charlie Task 4 |
| `<p>` inline-style merge (Futura dropped) | ✅ shipped | #66 |
| Editor-side rendering flicker | ⬜ open | Blackline (PR #74) |
| Image-overlay-text fonts | ⬜ triage | GPA Task 2 (#78) |

**Action:** this cluster is largely done. **Verify the shipped fixes (#111/#66/Charlie 4) clear the residual font complaints across all 6 merchants** (Charlie, Blackline, GPA, Fairechild, Castle, Buttercup) on re-import; file only what survives.

---

## D. Content blocks — biggest open surface, highly parallel
Per-block parser gaps. Each is independently shippable; many recur across merchants.

| Block issue | Merchants | Where |
|-------------|-----------|-------|
| Footers (links lost, layout, spacing) | Tiny Boat, Charlie, Roden Gray ×2 | Tiny Boat 3, Charlie footer-spacing, RG 1+2 |
| Hero background image + overlay buttons | Tiny Boat, Roden Gray | Tiny Boat 3, RG 1 |
| Trust-bar / badge rows | Tiny Boat | Tiny Boat 3 |
| Value / data tables | Roden Gray | RG 1 |
| Socials — dropped | Castle | ✅ #90 |
| Socials — wrong colors | Buttercup | Buttercup 3 (#86) |
| Image click-through links | Charlie, GPA | Charlie 6, GPA collapse |
| Text alignment / formatting / "copy mismatch" | Roden Gray, SHOC | RG 2 (copy-mismatch = flag), SHOC |
| Inline-anchor URL rewrite (footer + body) | Charlie | Charlie 3 |

**Sequence:** footers first (4-merchant recurrence — one fix, broad payoff), then hero/trust-bar, then the long tail. The RG "copy doesn't match original" is a **diagnose-first flag** (likely the coupon AI-rewrite — see Cluster F).

---

## E. Products — 5 merchants
| Item | Status | Where |
|------|--------|-------|
| AC product → dynamic cart-items (Cart Item filter) | ⬜ open | Charlie 2 |
| Browse-abandonment dynamic product (`event.Name` etc.) | ⬜ open | Charlie 7 |
| Customer Winback product block | ⬜ open | Buttercup 1 (#86) |
| Static products → Shopify name resolve (`_pendingProducts`) | ⬜ open (importer-side) | Charlie 2 notes, RG 2 |

**Sequence:** define the kl-product → Redo-block-per-trigger router once (Charlie 2 + 7), reuse for winback + static. Overlaps Content (D) for static-product blocks.

---

## F. Discount codes — scoped 2026-06-12 → [`discount-codes.md`](discount-codes.md)
Parse side built (`discount.ts` handles `{% coupon_code %}`). Open: import-side create+attach of a real Redo discount code (redoapp dependency). Recurs on welcome/promo flows ("Use the Code" buttons). See the dedicated plan.

---

## G. CODE templates — done
CODE-parser fidelity (container detection, per-span text, button links, socials) shipped via #91. Castle + Yes Homo CODE flows unblocked. Re-import to confirm; file residual only.

---

## H. Flow-level fields — confirm redoapp schema first
| Item | Status |
|------|--------|
| Flow-level audience / profile filter | ⏸ blocked — Charlie 8 |
| Re-entry interval (Klaviyo "wait N days before re-entry") | ⏸ blocked — Charlie 9 |

**Decision (Michael):** an executor digs redoapp's `AdvancedFlow` schema to confirm whether these slots exist. If yes → map; if no → precise warning. Don't guess.

---

## Cross-cluster decisions (settled)
- **WAIT** time-of-day / weekday loss → **accept as degraded mapping**, no work.
- **Silent-wrong is the enemy** across A, B, E: empty branches, survey→order_fulfilled, count-vs-value. Prefer a loud precise warning + fail-safe over a silent wrong default, everywhere.
- **Customer data** import is being built separately by Michael → unblocks segment member-copy + flow audiences.

## Recommended cluster order
1. **B Triggers** (decided, ready, small) → correct routing.
2. **A Conditions/Segments** (finish buildable parts) → correct targeting.
3. **E Products** (router once, reuse).
4. **D Content** (parallel; footers first).
5. **C Fonts** (verify-and-residual).
6. **F Discount codes** (scope now, build when RPC lands).
7. **H Flow-level fields** (dig → map/warn).

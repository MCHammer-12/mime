# Tiny Boat Nation feedback — 2026-06-12

Source: troubleshoot bundle `troubleshoot-tiny-boat-nation-2026-06-09T15-09-56-616Z.zip`
Job: `bca42727-6243-463e-baf5-bc618d6d6f57` (tiny-boat-nation)
Items: 4 flows (all imported OK; content + branch-logic feedback)

## Tasks (Tiny Boat-specific)

| # | Status | Task | Branch | PR |
|---|--------|------|--------|----|
| 1 | done | [Branch/split conditions on profile + event properties silently dropped](branch-conditions-dropped.md) | `fix/branch-conditions-dropped` | [#116](https://github.com/MCHammer-12/mime/pull/116) |
| 2 | blocked | [Klaviyo tag/list actions dropped — map to manage_customer_tags / manage_static_segment](tag-list-actions-to-redo-steps.md) | `fix/tag-list-actions-to-redo-steps` | — |
| 3 | partial | [Welcome Series — background image, hero buttons, trust bar, footer links broken](welcome-content-blocks.md) — #3 trust-bar fixed; #1 needs schema decision, #2 already works, #4 source-data | `fix/tbn-trust-bar-images` | [#126](https://github.com/MCHammer-12/mime/pull/126) |

## Headline

**Task 1 spans 3 of 4 flows and is the most impactful.** Every conditional split / branch that keys on a profile property or event property is migrating with an **empty `conditions: []`** — the branch silently does nothing, so customer targeting is wrong. The reviewer caught it in two flows; it's actually in three:
- SD8SuS: branch on `$viewed_items contains "ePropulsion"` → empty
- X3KsN3: trigger-split on cart `Items` (added specific product) → empty
- W2yEfw: `phone_number is-set` condition → empty

This is the broad version of the already-shipped Yes Homo Task 1 (phone-country-code → native `country` dimension, PR [#93](https://github.com/MCHammer-12/mime/pull/93)). That task's notes explicitly predicted: "extends beyond phone country codes — equals, contains, is-set, is-in-set." Tiny Boat is that prediction landing.

## Collapsed into other batches

| Issue | Affected flow | Owning task |
|-------|---------------|-------------|
| "Product sections not duplicated correctly" (dynamic cart products) | X3KsN3 | [Charlie Task 2 (ac-product-block-dynamic-cart)](../2026-05-26-charlie-1-horse/ac-product-block-dynamic-cart.md) |
| `reentry_criteria` (30d / 7d) not migrated | SD8SuS, X3KsN3 | [Charlie Task 9 (flow-product-filter-reentry)](../2026-05-26-charlie-1-horse/flow-product-filter-reentry.md) — done/blocked on Redo schema confirm; re-entry is the open half |
| `profile-not-in-flow` flow profile_filter not translated | SD8SuS, X3KsN3 | [Charlie Task 8 (flow-profile-filters)](../2026-05-26-charlie-1-horse/flow-profile-filters.md) family (flow-level audience filters) |

## Intended behavior (not bugs)

W2yEfw dropped actions `list-update`, `send-internal-alert`, `back-in-stock-delay` — per memory `feedback_drop_unsupported_actions`, update/list/alert actions are intentionally dropped + chain re-stitched. BUT the reviewer's "custom tags and fields not migrated" complaint is partly about tag/list actions that Redo CAN now represent — see Task 2 (supersedes the blanket drop for the tag/segment subset).

## Cross-cutting notes

**Klaviyo source bundled** — every flow folder has `klaviyo-flow.json` (real flow definition). Executors read condition/trigger shapes directly; template HTML still needs resolver/API.

**Flow IDs + triggers:**
- W2yEfw — Back In Stock - Standard — `back_in_stock` (Tasks 1 + 2)
- SD8SuS — BM | Browse Abandonment — `browse_abandoned` (Task 1: viewed_items branch)
- X3KsN3 — BM | Abandoned Cart Reminder — `cart_abandoned` (Task 1: added-product split; products→Charlie 2)
- RpEqCA — BM | Welcome Series — `email_signup` (Task 3: content)

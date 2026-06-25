# Segment module — port Klaviyo segments → Redo (design brief)

**Status:** design brief for the architecture thread. Not a task yet — Michael will work the design here, then it gets broken into tasks.
**Author note:** captures Michael's 2026-06-16 framing + the grounded Redo-side facts already dug up. Related: memory `feedback_segment_import_decision`, the existing `feat/segment-migration` branch (a partial implementation — see "Prior art").

## What we're trying to do

Give the migration a **dedicated segment module** so we can port a merchant's Klaviyo segments into Redo as part of the move off Klaviyo — selectable per segment, the same way templates/flows are. Today segments are only handled incidentally (a flow that references a list emits a "recreate it in Redo" warning); this makes segments a first-class, portable object.

## Desired UX (Michael)

1. **List all segments** in the merchant's Klaviyo account, each tagged **static** or **dynamic**.
2. **Static segments** → select the ones to port → **port them over**. Normally this is just an import (copy the segment + its members into Redo).
   - **Open Redo-side question:** is there an endpoint to import a static segment *with its members*? (See "Grounded constraints" — as of now, no.)
3. **Dynamic segments** → for each, the operator can select **one or both** of two port options:
   - **(1) Static snapshot** — a static Redo list of all the people *currently* in that segment (point-in-time membership; won't keep updating).
   - **(2) Dynamic recreation** — recreate the segment as a *dynamic* Redo segment using Redo's characteristics, so it auto-populates with any customers matching those fields going forward.
4. **Field mapping is the hard part.** Klaviyo has many characteristics; Redo has its own set; they don't line up 1:1. Mapping Klaviyo segment definitions → Redo characteristics is where most of the work is.

## Grounded constraints (Redo side — verified, re-confirm before building)

Merchant-callable RPCs that exist (`redo/merchant/marketing/rpc/.../segments/`):
- `createStaticSegment { name }` → creates an **empty** static segment (has `_id`).
- `createDynamicSegment { name, conditions }` → creates a **rule/dynamic** segment. Takes the **zod-shape** condition schema (`segment-zod-schema.ts`), NOT the flow CONDITION-step interface shape — getting this wrong = silent Zod 400 (see `project_segment_migration` memory).
- `fetchTeamSegments { … }` → list/dedup/match-by-name.
- `getSegmentMembers { … }` → read members.

**The blocking gap:** there is **NO merchant RPC to add members to a static segment.** `createStaticSegment` makes it empty; `updateStaticSegment` only renames. So:
- **Static-segment port** and the **dynamic "static snapshot" option (1)** both require populating members — which needs a **new redoapp endpoint** (`addCustomersToStaticSegment` or a bulk "import segment with members"). This is the same gap that blocks the in-flow static-list-membership work. **Architecture decision needed: spec that endpoint.**
- **Dynamic recreation option (2)** is buildable today via `createDynamicSegment` — it's purely a translation problem (Klaviyo definition → Redo conditions). No member copy.

Other facts:
- **Member match is email-based**, and customers must already exist in Redo → sequence after the customer-data import Michael is building.
- Static-snapshot membership is a **point-in-time copy** (no ongoing Klaviyo sync) — fine since the merchant is leaving Klaviyo.

## Prior art — `feat/segment-migration` branch (don't start from scratch)

A working partial implementation already exists (built 2026-06-11, **unmerged, never live-validated**): engine in `src/segments/*` (`translate`, `substitutions`, `maps`, `redo-client`), `src/migrate/segments-import.ts`, and a **Segments tab** in the dashboard. It already does:
- **Dynamic → dynamic recreation** (option 2) with three tiers: **exact** (profile-metric, consent, group-membership, email/country/region), **substituted** (predictive: CLV → order-count ÷ AOV, churn → no-order-in-N-days, AOV → order_total, EU → 27 ISO codes), **unsupported** (predicted gender, next-order-date, postal distance, custom props → dropped).
- **±10% count verification**: `getSegmentCount` computes a Redo count *without persisting*, compares to Klaviyo `profile_count`, and binary-search auto-tunes the substituted thresholds to land on Klaviyo's population.

So **option (2) and the "list + type" UX are largely prototyped** on that branch. What this brief adds on top: the **static-segment port**, the **dynamic "static snapshot" option (1)**, the **per-segment select-one-or-both UX**, and the **member-populate endpoint** — all of which converge on the missing add-members RPC.

## For the architecture thread to decide
- **The add-members endpoint** (redoapp): spec a merchant-callable "create static segment + add members" (or bulk "import segment with members"). This unblocks static ports, snapshot option, AND the in-flow static-list work. Single highest-leverage decision.
- **Field-mapping model**: how to represent Klaviyo→Redo characteristic mapping (extend `src/segments/maps.ts` + `substitutions.ts`?), how to surface unmappable fields to the operator, and where the human-in-the-loop approval lives (the existing `needs_input` job modal).
- **Merge + live-validate `feat/segment-migration`** as the foundation, or refactor its engine into the cleaner module shape this brief describes.
- **Customer-import sequencing**: member copy depends on customers existing in Redo first.

## Relationship to existing queued work
- `feedback_segment_import_decision` memory + ad-hoc Task 4 (`segment-auto-creation-at-import`): the *in-flow* version (a flow branch/action that needs a segment). Shares the exact same add-members gap. This module is the *standalone, operator-driven* version. Both should sit on one shared segment-resolution + member-populate layer.

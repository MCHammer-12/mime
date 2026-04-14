# Decisions

## 2026-04-14 — Footer: keep as Text block, don't use Redo's FooterBlock
Klaviyo footers are text blocks containing `{% unsubscribe %}` and `{{ organization.* }}`. Original plan (per `project_klaviyo_footer_variables.md` and `TODO-SHARED-text.md` PRIORITY 0) was to convert them to Redo's `FooterBlock` with `schemaFieldName: "unsubscribeLink"` and `useTemplateAddress: true`. Prototyped end-to-end, but reversed after viewing rendered output: FooterBlock forces its own fixed copy/order ("business name / address / city-state-zip / country / Unsubscribe") with no configurable preamble, destroying Klaviyo's phrasing ("No longer want to receive these emails?") and merchant customization. Decision: keep as TextBlock and substitute the variables inline in the export pipeline — `{% unsubscribe %}` → `<a href="{{ unsubscribe_link }}">unsubscribe</a>` (Redo recognizes `{{ unsubscribe_link }}` inside text per `hasUnsubscribeLink` in web email-builder utils), and org variables → merchant-provided values from Klaviyo Accounts API (or user prompt fallback). Placeholder text is unacceptable — if API call fails, migration must prompt before proceeding. No new block type; no FooterBlock added to `types.ts`. Abandoned files: `src/parser/blocks/footer.ts`, `src/renderer/blocks/footer.tsx`.

## 2026-04-14 — Discount: split text block, not a hybrid
Klaviyo `{% coupon_code 'Name' %}` can appear either standalone (its own line between `<br/>`s) or inline in a sentence. Redo has no inline coupon primitive — a coupon must be its own DiscountBlock with an associated Redo discount object. Decision: deterministic parser handles standalone coupons only, splitting the surrounding text block into `[text, discount, text]`; inline coupons are left in the text block for the migration's downstream AI-rewrite pass to handle. Michael explicitly confirmed this over a "text/discount hybrid" block, which was considered and rejected because the prod schema offers no such hybrid.

## 2026-04-14 — Socials icon color: lossy mapping to prod enum
Prod Redo's `SocialIconColor` enum allows only `black`/`white`/`gray`. Local `types.ts` still lists `original` but it fails prod Zod validation. Klaviyo's `/default/` CDN path serves colorful branded icons with no exact Redo equivalent. Decision: `/default/` → `black`. Michael confirmed exact icon color match is not required for migrations as long as background, URLs, and padding are correct.

## 2026-04-14 — Klaviyo hlb-wrapper → Redo ImageBlock (not HeaderBlock)
Klaviyo's Header/Logo Bar (`hlb-wrapper`, used by 91% of templates) combines a logo image with optional menu links. Redo has a native `HeaderBlock`, but it auto-pulls the logo from the team's brand kit — unreliable for migrations where the brand kit may not be set. Decision: `parseHeaderBlock` emits an `ImageBlock` for the logo portion (width preserved via calculated horizontal inner padding so a 300px Klaviyo logo renders at ~300px in the 600px Redo email), and `parseMenuFromHeader` separately emits a `MenuBlock` for nav links. The `header.tsx` renderer is now dead code for Klaviyo migrations.

## 2026-04-08 — Klaviyo API revision: `2025-10-15`
The `additional-fields[flow]=definition` param, which returns the full flow graph with edges and branch conditions, is only accepted on revision `2025-10-15` or later. Earlier revisions (including the "current stable" 2024-10-15) return `additional-fields must be in []: (got definition)`. Shared client pinned to `2025-10-15`.

## 2026-04-08 — HTML-only translation path
Klaviyo's template API exposes the flattened `html` of drag-drop templates, not the block JSON (`editor_type: SYSTEM_DRAGGABLE`/`USER_DRAGGABLE`). There is no block-to-block mapping shortcut. Any translator to Redo JSON must parse HTML (LLM-assisted).

## 2026-04-08 — Campaign templates are inline, not cross-referenced
Campaign-scoped template clones do NOT appear in the `/templates/` listing endpoint. The Task G normalizer (future) must pull template data from campaign bundles directly for campaigns, and from `templates-manifest.json` only for flows.

## 2026-04-08 — Two-track project structure
Track 1 (production): improve the existing Redo email forwarder with an LLM parser. Track 2 (exploratory): React HTML drag-drop POC. A full rewrite to HTML-native (GrapesJS) or MJML is NOT on the critical path — Track 1's experiment determines whether it's needed.

## 2026-04-08 — Don't screen-scrape Klaviyo
We confirmed the public API returns the full topology, so reverse-engineering the web UI (Playwright + network intercept) is no longer needed. Branch edges, conditions, trigger metrics, profile filters, and email content all come from the public `definition` field.

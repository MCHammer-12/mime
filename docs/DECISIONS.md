# Decisions

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

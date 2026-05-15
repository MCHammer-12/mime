# Session Log

## 2026-05-07/11 — External assist surface, admin identity + lockdown, drag-reorder, hours-saved tally

**Context**
Long session that stood up the external-facing `/assist` UI (note-taking for Dennis/Toby), the admin-side Austin/Michael identity model with a hard slot-lock, drag-and-drop card priority, and a sequence of UX follow-ups against live use. Replit Private Deployment stays the outer fence; everything inside is in-app gating. 18 merged PRs.

**Done — `/assist` external view ([#41](https://github.com/MCHammer-12/mime/pull/41))**
- `/` serves a new "redo"-branded SPA — brand-card picker + per-brand items list + per-item note textarea. Admin "Toby 2.0" UI moves from `/` to `/<ADMIN_URL_TOKEN>/`; visiting sets an HttpOnly cookie; admin API endpoints gate via `requireAdmin`. `/admin/` is the dev fallback when token is unset.
- New `imported_items` table (migration 004) — flat per-store list denormalized at the existing `exported` / `flow_imported` / `imported` event points so the assist read path is one indexed query (vs scanning job_events). Replit's stateless filesystem means we can't read off disk anymore.
- `jobs.notes` JSONB upgrades from `Record<itemId,string>` to `string | {text,author,savedAt}` — assist UI attributes notes via `?as=Dennis` query param; legacy admin notes still read cleanly via `coerceNote`. Bundle exporter coerces both shapes.
- 4 new endpoints: `GET /api/assist/stores`, `GET /api/assist/stores/:id/items`, `POST .../note`, `POST .../done`.

**Done — "Hours saved" tally + completion toast → removed ([#42](https://github.com/MCHammer-12/mime/pull/42), [#48](https://github.com/MCHammer-12/mime/pull/48), [#53](https://github.com/MCHammer-12/mime/pull/53))**
- `imported_items.email_count` (migration 005) — 1 for templates/campaign variants, `createdTemplateCount + blankTemplateCount` for flows. `GET /api/admin/metrics` returns SUM. Header chip shows `Hours saved: X` (ceil(emails×20min/60)).
- Center-screen toast on job completion: "you just did X Nigerian hours of duplication work". Shipped with auto-dismiss (#42) → got a "heck yeah" button (#48) → removed entirely (#53) per Michael. Header counter stayed.

**Done — Assist checkboxes, search, Mine/All filter, completion grayout ([#49](https://github.com/MCHammer-12/mime/pull/49))**
- Per-item checkbox on the brand detail view, persisted to new `assist_completions` table (migration 006) keyed by `(store_id, item_id, assistant)`. Brand cards gray out + render a green check when the current `?as=` has checked everything off.
- Search bar (case-insensitive on storeName).
- "Mine | All" filter — Mine = brands the requesting assistant has engaged (≥1 note OR ≥1 done). Default Mine when `?as=` present.

**Done — Admin Austin/Michael identity + Mine/All on Stores ([#51](https://github.com/MCHammer-12/mime/pull/51))**
- First-visit modal asks "Who's using this? Austin / Michael". Choice persists via `admin_user` cookie (1y). Header chip with ✕ to switch. `stores.created_by` column (migration 007) populated at create time; admin troubleshoot notes also pick up the author.
- Mine | All filter on the admin Stores dashboard. Defaults to "Mine". `· by Michael` / `· by Austin` badge on each card.
- Endpoints: `GET/POST/DELETE /api/admin/identity`.

**Done — View as Dennis/Toby preview ([#54](https://github.com/MCHammer-12/mime/pull/54))**
- Admin TopBar chip with one link per assistant; opens `/?as=<name>&preview=1` in a new tab. Preview mode shows a banner ("Previewing as Dennis · read-only") and short-circuits `onSaveNote` / `onToggleDone` so writes don't fire.

**Done — Drag-and-drop brand card reorder ([#55](https://github.com/MCHammer-12/mime/pull/55))**
- Each assistant drags brand cards into priority order; persists per `?as=`. New `card_priority(user_name, store_id, position)` table (migration 008). Native HTML5 drag-drop (no extra deps). Drag disabled when a search or Mine filter would hide cards (with a hint). Drag-end debounces a single POST 250ms.

**Done — Admin lockdown + nav between surfaces ([#56](https://github.com/MCHammer-12/mime/pull/56))**
- `admin_claims(user_name PK, claim_token, claimed_at)` (migration 009). First browser to pick Austin/Michael claims the slot via a generated random token mirrored into an HttpOnly `admin_claim` cookie. After both slots claimed, no new browser can authenticate — identity modal disables both options; `requireFullAdmin` 401s every other admin endpoint until a valid claim is presented. Reset path is psql-only by design.
- Admin TopBar adds "Assist ↗"; assist header adds "← Admin" when `/api/me` says the requester is a verified admin. Assistants never see the back link.

**Done — Toast removal + plain-text credential inputs ([#47](https://github.com/MCHammer-12/mime/pull/47), [#50](https://github.com/MCHammer-12/mime/pull/50), [#53](https://github.com/MCHammer-12/mime/pull/53))**
- Klaviyo key + Redo JWT now render as plain text in the Add/Edit-store modal and the legacy CredentialsBar. Operator pastes them repeatedly while working through merchants; masking added friction without meaningful security on a gated admin route.

**Done — Vercel deploy attempted, then abandoned ([#52](https://github.com/MCHammer-12/mime/pull/52) closed)**
- Built a parallel Vercel deployment of just the `/assist` UI + 4 endpoints against the same Postgres, with a shared-token gate. Tore it down before going live — assistants got invited to the Replit workspace instead so the existing private-deployment URL suffices. Code branched (`feature/vercel-assist-deploy`) exists if we ever revisit.

**Done — Bugfixes ([#57](https://github.com/MCHammer-12/mime/pull/57), [#58](https://github.com/MCHammer-12/mime/pull/58))**
- Mine filter on dashboard was always 0 — `mock-stores.js` stripped `createdBy` when normalizing the API response. One-line passthrough fix.
- JWT-expired indicator now shows in Add mode (not just edit), with a clear "couldn't read store ID" hint when token isn't a JWT — silent disabled-Save was the most-reported Add Store confusion.
- Mine filter on dashboard includes legacy (null `created_by`) stores — they vanished after #57 made the filter actually work; now treated as "unclaimed, visible to both". Subtitle reads "created by Michael or unclaimed".
- Admin "Assist ↗" link passes `?as=<adminUser>` so Michael can open assist signed in as himself (writes attribute correctly). View-as preview links unchanged.
- Brand picker scope defaults to "all" in `preview=1` mode (Michael previewing wants the full set, not just engaged brands).

**Files changed (cross-PR)**
- `src/migrate/db.ts` — migrations 004-009
- `src/migrate/auth.ts` — admin_token / admin_user / admin_claim cookie helpers; `appendHeader` for stacking; `ALLOWED_ADMIN_USERS`
- `src/migrate/claims.ts` (NEW) — tryClaim / userForClaimToken / getClaimStatus
- `src/migrate/imported-items.ts` (NEW) — listAssistStores / listAssistItemsForStore / setAssistDone / getCardOrder / setCardOrder / getTotalEmailsImported
- `src/migrate/jobs.ts` — `setNote` accepts optional author; `coerceNote`; `recordImported` on RunController
- `src/migrate/server.ts` — admin gating; `requireFullAdmin`; `/api/me`; `/api/admin/identity` x 3; `/api/admin/metrics`; `/api/assist/stores/items/note/done`; `/api/assist/cards/order`; admin URL routing
- `src/migrate/stores.ts` — `createdBy` field through record + summary + create input
- `src/migrate/ui/index.html`, `src/migrate/ui/assist.html` (NEW) — separate SPAs
- `src/migrate/ui/components/app.jsx` — ViewAsLinks, IdentityModal, "Assist ↗"
- `src/migrate/ui/components/dashboard.jsx` — Mine/All filter; createdBy badge
- `src/migrate/ui/components/assist-app.jsx` / `assist-stores.jsx` / `assist-items.jsx` (NEW)
- `src/migrate/ui/components/setup-modal.jsx` — JWT-expired/decode-failed indicators
- `src/migrate/ui/components/credentials.jsx` — plaintext Klaviyo + JWT
- `src/migrate/ui/components/jobs.jsx` — coerce structured-shape notes in admin troubleshoot panel
- `src/migrate/ui/mock-stores.js` — pass createdBy through
- `CLAUDE.md` (NEW project-level)
- `plans/2026-05-07-assistant-notes-view.md`, `plans/2026-05-08-vercel-assist-deploy.md`

**Decisions (see DECISIONS.md)**
- Admin obscure-URL token + cookie session (chose over Replit Auth headers — keeps the deployment private and avoids per-seat invite costs).
- Admin identity (Austin/Michael) claimed first-come-first-served, locked to one browser per slot via random claim_token in DB + HttpOnly cookie. Reset only via psql.
- Notes shape upgrade: structured `{text, author, savedAt}` coexists with legacy bare strings; readers coerce via `coerceNote`.
- View-as preview: read-only via `?preview=1` query param — short-circuits writes; banner surfaces "Previewing as X".
- Assist surface stays on the Replit Private Deployment (Vercel attempt closed). Per-assistant URLs (`/?as=Dennis`, `/?as=Toby`).
- Drag-reorder is per-user, debounced 250ms, only enabled when no filter is hiding cards.
- Mine filter on admin Stores includes legacy null-`created_by` rows as "unclaimed, visible to both".

**Parallel session work (other Claude track, merged in same window — not mine, noted for the log)**
- [#59](https://github.com/MCHammer-12/mime/pull/59) Full Order Tracking trigger set + generic Reviews trigger.
- [#60](https://github.com/MCHammer-12/mime/pull/60) 10s heartbeat on `/api/jobs/:id/stream` — fixes Replit autoscale proxy killing idle streams during `needs_input` waits (the trigger picker modal would die before the operator could answer).
- [#61](https://github.com/MCHammer-12/mime/pull/61) Flow-imported templates inherit the flow's `schemaType` (was hardcoded `marketing_email` — broke back-in-stock dynamic vars).

**Next steps (in priority order)**
1. **Verify lockdown on prod:** after Replit deploys #56, walk through claim flow with both Michael's and Austin's actual browsers; confirm a third browser is blocked. Reset path documented (psql `DELETE FROM admin_claims WHERE user_name = …`).
2. **"Can't mark flows done" follow-up:** Michael reported on /assist; suspected cause was preview-mode writes disabled. #58 added Assist-as-me link (`/?as=Michael`). Verify after Michael uses that link.
3. **Empty stores in /assist:** by design they don't show (assist reads `imported_items`, not `stores`). Quikcamo example. Pending decision whether to surface empty cards anyway.
4. **Replit DB scheme-diff prompt:** noted in CLAUDE.md not to use; reminded once when "DROP TABLE stores CASCADE" was suggested due to dev/prod drift.
5. Continuing parser/import work from prior session is still pending (Yotpo aliases, importer-side `_pendingProducts` resolution, etc.).
6. **Verify back-in-stock vars** after #61 — re-import a back-in-stock flow and confirm `productName` / `productUrl` show up as bindable variables.
7. **Verify needs_input survives long picks** after #60 — re-trigger the Fairechild Review-Request flow that originally hit the network-error and pick from the modal after a delay.

---

## 2026-05-06/07 — Pretty Cult / Fore All / Gaidama bundle pass: bg, fonts, flow drops, SMS migration, Yotpo, saved templates

**Context**
Long live-use session against Pretty Cult (multiple bundles), Fore All UmQdKw failure, and Gaidama Yotpo flows. Triaged each bundle as it landed, fixed the underlying parser/importer bug or extended schema coverage, shipped 8 PRs.

**Done — bg ancestor walker + system-font substitute ([#31](https://github.com/MCHammer-12/mime/pull/31))**
- `findAncestorBackgroundColor` now walks every DOM ancestor (not just `td`), catching MJML section bg-divs / wrapping tables / body bg. Wired up the parsers that had hardcoded `"#ffffff"` fallbacks (button, line, socials, image, header, spacer, menu, klaviyo-specific, product, column, discount).
- `New York` and `Baskerville` (Apple/Linotype system serifs, not on Google Fonts) → substitute to Georgia at parse time. Block-level via `parseFontFamily`; inline span declarations via new `substituteSystemFontsInHtml` pre-pass in the text parser.
- Same PR also bundled: drop-policy for un-translatable flow actions (update-profile/list-update/target-date/heavily-unmapped-webhook) → drop-and-restitch chain (was WAIT stub); ab-test → extract `data.main_action` as a real send-email step; `organization.name` substitution in subject + preview (new `substituteStringVars`); `{{ event.extra.responsive_checkout_url }}` → `checkoutUrl` dynamic variable; static product blocks → real Products block with `productSelectionType: "static"` + `_pendingProducts` (importer-side resolution required); adjacent same-shape Products blocks merge with name dedup; AC context override (cart signal in doc → upgrade static product blocks to dynamic + Cart Item filter); social icon color from section-bg luminance; link color walks up ancestor spans for inherited `color:`; default `#000000` text/link on dark-bg sections → swap to white.
- New memory: `feedback_drop_unsupported_actions` (drop-not-stub policy), `project_discount_codes_open_question` (parked decision), `project_sms_migration_plan` (now superseded by #32).

**Done — SMS migration ([#32](https://github.com/MCHammer-12/mime/pull/32))**
- send-sms now emits real `SendSmsStep` + `placeholderSmsTemplate`. importFlowRpc loops the placeholders → `createSmsTemplate` RPC → swaps sentinel templateId. Body Liquid through existing `rewriteKlaviyoLiquid`. Empty body (Klaviyo AI-content templates) → WAIT stub fallback. MMS image_id captured + dropped with warning (deferred to v2).
- Fixed `SendSmsStep` type (was bogus `body: string`, now `templateId` + `phoneNumberFieldName: "customerPhone"` + `recipientNameFieldName: "customerFirstName"` per `send-sms.it.spec.ts`).
- New `src/flow/sms.smoke.ts` smoke test verifies 1:1 step↔placeholder pairing.

**Done — `person|lookup:"X"` Liquid translation ([#33](https://github.com/MCHammer-12/mime/pull/33))**
- Pretty Cult AC SMS bundle showed `{{ person|lookup:"first_name"|default:'' }}` rendering as empty string. Rewriter was treating the `lookup:` form as unmapped. Now strips the lookup filter and routes the field through `KLAVIYO_TO_REDO_VAR_MAP`. Tolerant of single/double quotes, optional `$` prefix (legacy Swell), whitespace around `:`. Filter chain after lookup (`|default:`, `|upcase`) preserved.

**Done — split-block image padding + WCAG contrast ([#34](https://github.com/MCHammer-12/mime/pull/34))**
- `parseSplitSubblock` only read padding from a `td.spacer` and dropped to zero when missing. Now sums every td between the `<img>` and the kl-split-subblock div as a fallback.
- Replaced "all-color-sources-unset → swap to white" heuristic with WCAG contrast check (`contrastRatio` helper). Resolved color contrasting below 3:1 against section bg → swap to whichever of black/white reads better. Catches the Klaviyo CSS-default `#15c` blue link on a black bg case where divStyle.color was set but still poor contrast. Same logic in product-block titles.

**Done — line-height as `<br><br>` + product merge across spacers/lines ([#35](https://github.com/MCHammer-12/mime/pull/35))**
- Klaviyo `line-height: 2` doesn't render in Redo. When `divStyle["line-height"]` parses as ≥ 1.7, replace each `<br>` with `<br><br>` and drop the inline line-height. New `parseLineHeightUnitless` helper.
- Static-Products merge now walks back over only SPACER / LINE sections to find the most recent ProductsBlock candidate. Drops the intervening decorative sections. Non-decorative sections still break the chain so logical groupings stay separate.

**Done — bundle failed flow imports with full context ([#36](https://github.com/MCHammer-12/mime/pull/36))**
- When `createAdvancedFlow` failed, the troubleshoot bundle had only README + manifest. Parsed automation was discarded by the catch block; Klaviyo source flow JSON was never captured for failures; the full Zod error string was only on the UI's compact `fail` event.
- New `flow_failed` event carries `parsedAutomation`, `klaviyoFlow`, `error`, `warningList`. bundle.ts reads it: writes `parse-result.json` (`{ status: "failed", error, warnings, parsedAutomation }`), `klaviyo-flow.json`, `error.txt`. Compact `fail` event preserved for UI red-row indicator.

**Done — Yotpo Integration triggers ([#37](https://github.com/MCHammer-12/mime/pull/37))**
- 12 Yotpo Loyalty + Reviews triggers now route Klaviyo metric → Redo Integration-category trigger. Per redoapp `advanced-flow-db-parser.ts:618-625`, no `eventName` / `triggerSpecificFields` required; `key` and `schemaType` strings match.
- New `IntegrationTriggerKey` type alias; `FlowCategory` widened to include `"Integration"`; `TriggerKey` union extended.
- 30+ aliases in METRIC_NAME_MAP covering Yotpo Swell (legacy) + Yotpo Loyalty (current) + display-form names. Verification against a live Yotpo merchant (Gaidama) still TODO.
- All 12 also added to user-facing trigger picker as fallback.

**Done — Saved Templates instead of Previous Emails ([#38](https://github.com/MCHammer-12/mime/pull/38))**
- Saved templates and previous emails are two separate Mongo collections (`SavedEmailTemplate` vs `EmailTemplate`), not a flag. Mime was always calling `createEmailTemplate` → everything landed in Previous Emails.
- New `asSavedTemplate?: boolean` opt on `importTemplateRpc`. Standalone template imports + campaign imports pass `true` → `createSavedEmailTemplate` RPC with `source: "saved"` → wrapper doc in SavedEmailTemplates collection. Flow placeholder templates KEEP using `createEmailTemplate` because flow `send_email.templateId` references EmailTemplate `_id` at send time.

**Files changed (cross-PR)**
- `src/parser/style-utils.ts`, `src/parser/index.ts`, `src/parser/url-mapping.ts`
- `src/parser/blocks/{button,column,discount,header,image,klaviyo-specific,line,menu,product,socials,spacer,text}.ts`
- `src/fonts.ts`, `src/transform.ts`, `src/export-template.ts`, `src/export-flow.ts`
- `src/flow/parser.ts`, `src/flow/types.ts`, `src/flow/trigger-mapping.ts`, `src/flow/marketing-trigger-options.ts`, `src/flow/variable-mapping.ts`, `src/flow/import-one.ts`
- `src/flow/sms.smoke.ts` (NEW)
- `src/migrate/server.ts`, `src/migrate/import-rpc.ts`, `src/migrate/bundle.ts`
- `src/renderer/types.ts`
- `plans/sms-migration.md` (NEW)

**Decisions (see DECISIONS.md)**
- System fonts substitute to Redo system fonts at parse time, not Google Fonts.
- Drop-not-stub for un-translatable flow actions (supersedes `feedback_skipped_action_mappings`).
- ab-test → extract embedded main_action.
- Static product blocks → Products block + `_pendingProducts` (importer-side Shopify name resolution).
- WCAG contrast guard for text + link colors instead of "all-unset" heuristic.
- Saved templates use a different RPC (different collection); flow-attached emails stay as EmailTemplate.

**Next steps (in priority order)**
1. **Live test the saved-templates split** — re-import a merchant; confirm Saved Templates tab populates and flow-attached emails still send (their `send_email.templateId` references survive).
2. **Verify Yotpo aliases on Gaidama** — re-import; if any flow lands in the trigger picker with a Yotpo metric not in our aliases, add the missing entry.
3. **Discount codes** still parked (memory `project_discount_codes_open_question`). User confirmed it now blocks SMS UX too. Likely needs redoapp-side change to programmatically create + attach a code at import time.
4. **Importer-side `_pendingProducts` resolution** — redoapp `import-klaviyo-templates.ts` doesn't yet swap `_pendingProducts` for `manuallySelectedProducts` via Shopify name search. Mime is emitting; importer hasn't been updated.
5. **MMS attachments support** for SMS (deferred to v2). Currently dropped with warning.

---

## 2026-04-30 — Live merchant fixes: text vars, padding, troubleshoot bundle, trigger picker, campaigns filter

**Context**
Live-use feedback from running the migration on Gaidama, Roden Gray, nevermindall usa, quikcamo. Triaged ~18 issues into 6 root-cause groups, then worked through them across four merged PRs.

**Done — text-block variable substitution ([#17](https://github.com/MCHammer-12/mime/pull/17))**
- `transform.ts`: drop `manage_preferences*` / `email_preference_url` anchors with adjacent " | " / " or " separators (no Redo equivalent).
- Map `{% web_view %}` / `{% web_view 'X' %}` / `{% web_view_link %}` (in href) → `{{ view_in_browser_link }}` after confirming the field exists in `redoapp/redo/model/src/email-builder/shared-schema-fields.ts` (sharedEmailSchemaFields).
- Map `{% unsubscribe 'X' %}` (custom-text form), `{% unsubscribe_link %}` (URL form in href).
- Map `{{ first_name }}`, `{{ person.* }}` → `{{ customer_* }}`; `{{ shop.name }}` / `{{ shop_name }}` → org name.
- New `TransformResult.warnings` field; data-loss drops surface via the existing migrate UI warn count.
- `isEffectivelyEmpty()` drops a text block whose only content was the stripped tag.
- Cleanup pass removes empty inline tags + collapses double separators after a middle-of-chain anchor drop.

**Done — section padding fixes + troubleshoot bundle ([#18](https://github.com/MCHammer-12/mime/pull/18))**
- `parseSplitBlock`: replaced hardcoded `sectionPadding: {0,0,0,0}` with `sumAncestorPadding($td)` so the kl-split td's outer ancestors contribute padding.
- `parseColumnRow`: same fix via new `extractRowSectionPadding` walker (4 enclosing tds above kl-row); padding distributed to first/last zippered ColumnBlock so intermediate rows don't double-pad.
- New per-job Troubleshoot panel (jobs.jsx + app.jsx + bundle.ts + bundle.smoke.ts):
  - Notes per template/flow stored in new `jobs.notes` JSONB column (migration 002), POST `/api/jobs/:id/notes`
  - "Export zip (N)" button POSTs to new `/api/jobs/:id/bundle` → archiver streams a zip (Klaviyo source HTML+JSON, Redo `.redo-template.json`, parse-result with full warnings/subs/review/skipped, notes, manifest, README)
  - `exported` event payload now includes the full warning/substitution/review/skipped lists so the bundle has them without re-running the parser.
  - Verified end-to-end via `bundle.smoke.ts`: zip contains exactly the expected files with no duplicates after a `.sections.json` collision was caught + filtered out.

**Done — trigger recovery picker ([#20](https://github.com/MCHammer-12/mime/pull/20))**
- `parseFlow` accepts `opts.forcedTrigger`; `ParseResult.skipped` now carries `recoverable: true` + `klaviyoTrigger` so the caller can prompt the user.
- New `src/flow/marketing-trigger-options.ts` mirrors Redo's marketing-trigger list (13 options) with display labels matching `redoapp/redo/model/src/advanced-flow/triggers.ts schemaTypeConfigs`. Abandonment options keep `autoSkipAbandonmentField`.
- Server flow-import: detect recoverable skip → emit `needs_input` (type=choice) → re-parse with `forcedTrigger` → import normally. "Skip this item" gracefully fails the flow.
- Modal: scrolls when option count > 8; new `PendingInput.hideApplyAll` suppresses the misleading "apply to others" checkbox for per-flow questions (per-flow questionKey means cache reuse never fires anyway).
- Smoke test (`src/flow/parser.smoke.ts`) proves the round-trip.

**Done — campaigns 400 + flow status diagnostic ([#21](https://github.com/MCHammer-12/mime/pull/21))**
- Switched `/campaigns/?filter=equals(messages.channel,'email')` to double-quoted `"email"` to match the working flow-messages filter; some Klaviyo accounts reject single-quoted strings with 400. Same fix in `src/extract-campaigns.ts`.
- `klaviyo.ts`: parse Klaviyo's structured `errors[0].detail/title/code` and lift it to the front of the thrown error message so a truncated UI display surfaces the actionable reason instead of just the URL prefix.
- Flow status: parser code is correct (`enabled = status === "live"`). Added per-flow info emit `Klaviyo status="X" → Redo enabled=Y` and propagated `enabled` + `klaviyoStatus` onto the `flow_imported` event payload so the next import surfaces the mapping for verification.

**Files changed (cross-PR)**
- `src/transform.ts`, `src/export-template.ts`
- `src/parser/blocks/column.ts`
- `src/migrate/server.ts`, `src/migrate/jobs.ts`, `src/migrate/db.ts`
- `src/migrate/bundle.ts` (NEW), `src/migrate/bundle.smoke.ts` (NEW)
- `src/migrate/ui/components/jobs.jsx`, `src/migrate/ui/components/app.jsx`, `src/migrate/ui/components/needs-input.jsx`, `src/migrate/ui/mock-stream.js`
- `src/flow/parser.ts`, `src/flow/types.ts`
- `src/flow/marketing-trigger-options.ts` (NEW), `src/flow/parser.smoke.ts` (NEW)
- `src/extract-campaigns.ts`, `src/klaviyo.ts`
- `package.json` / `package-lock.json` (added `archiver`)

**Decisions (see DECISIONS.md)**
- Map vs drop for Klaviyo footer tags: map when Redo has an equivalent (`view_in_browser_link`), drop+warn otherwise.
- Bundle delivery: zip download (not paste-ready markdown) — covers deep-debugging without truncation.
- Trigger recovery: re-parse with `forcedTrigger` override after the user picks, rather than mid-import patching.
- Klaviyo filter strings: standardize on double quotes.

**Next steps (in priority order)**
1. Live test [#21](https://github.com/MCHammer-12/mime/pull/21): verify campaigns filter resolves on the failing merchant; confirm flow status diagnostic shows correct mapping.
2. Drop a troubleshoot bundle for the remaining group-2/4 issues:
   - Roden Gray "3.6.21 |Launch": split-padding fix is live, but button-in-wrong-column still open
   - nevermindall: image+product duplication, footer column text padding, bold inversion
   - Roden Gray: GIF → 2 images + 2 text blocks, table-based footer breaks
   - nevermindall AC2: menu didn't copy
3. Group 3: bestsellers / cart-item filter creation broken (nevermindall) — code-readable, no HTML needed.
4. Group 5 leftovers: Toby branches need config warnings, weird branch names, end-of-flow showing as message.
5. Replit deploy: revisit the deferred plan once trigger picker + bundle are exercised in production.

---

## 2026-04-15 — Image element deep-dive + Klaviyo checkout URL mapping

**Context**
Continued the per-element deep-dive from `plans/element-deep-dive.md`. Scope:
`src/parser/blocks/image.ts` and `src/renderer/blocks/image.tsx`. Test fixtures:
Nugivf logo + hero, QP9hma grid-pixel (gxp- variant), QPETZp flow template
(including a 200px centered image), RfTv2d/WyxTcg/SvGNVx/Wyj7Sk cart+checkout
discount templates, UNaeqg checkout-gloves (image-as-CTA design).

**Done — image parser + renderer**
- **Padding-td fallback:** when `kl-img-base-auto-width` class is absent (e.g.
  the QPETZp 200px image's container td has `class=""`), fall back to the td
  containing the `<img>` tag, then to the kl-image td itself. Fixed
  silent-zero-padding parse of images in this shape.
- **Constrained-width centering:** if the image's container td declares an
  explicit `width:` smaller than `EMAIL_MAX_WIDTH_PX - sectionPadding`,
  compute horizontal inner padding to center the image at its native size.
  Fixes QP9hma 560px image (was stretching to 580px; now `padding={10,20,10,20}`)
  and QPETZp 200px image (was stretching to 600px; now `padding={0,200,0,200}`).
- **`showCaption: false`** on all imports (Zod schema requires it).
- **sectionColor fallback** reads `$wrapper.attr("style")` in addition to the
  first td's inline style.
- **Renderer: inner padding now applied.** `EmailImage` threads
  `props.padding` into `MjmlText` padding props; `NestedEmailImage` wraps
  `WithLink` in a div that applies `props.padding`. Previously parsed but
  never rendered.

**Done — Klaviyo checkout URL → Redo dynamic variable**
- Confirmed with Redo team that `schemaInstance.checkoutUrl` is already wired
  end-to-end for button blocks: schema-registered on all four abandonment
  schemas, populated at send time by the abandonment email handler, resolved
  in `button.tsx:268-272`, exposed in the builder's dynamic-variable dropdown.
  Only gap on Redo's side: not yet supported on image blocks.
- Created `src/parser/url-mapping.ts` with `mapKlaviyoLink(url)` returning
  either `{linkType:"dynamic-variable", schemaFieldName:"checkoutUrl"}` or
  `{linkType:"web-page", buttonLink}`. Detects `{{ event.URL }}`,
  `{{ event.CheckoutURL }}`, `{{ event.extra.checkout_url }}` (whitespace +
  Liquid-filter tolerant).
- Wired into `src/parser/blocks/button.ts`. Verified: three abandoned-cart
  templates (XRXjBJ, VGQunZ, XSyzE6) now emit correct dynamic-variable shape;
  static campaign buttons (QP9hma) unchanged.
- Commits `3bea718` (url-mapping hoist + three-state classifier) and
  `caf90ad` (types aligned with prod Zod) landed earlier today.

**External dependency filed**
- Sent Redo's internal AI coder instructions to add dynamic-variable support
  to the image block (mirror of the button work: `clickthroughLinkType` +
  `clickthroughSchemaFieldName` on ImageBlock, renderer resolution via
  `schemaInstance`, builder UI picker). PR will be reviewed later. Once it
  lands, 10-minute parser update in `image.ts` using the same
  `mapKlaviyoLink()` helper will close the loop for the image-as-CTA pattern
  heavy in UNaeqg (9 images, 2 with `{{ event.URL }}` clickthroughs).

**Memory updates**
- Added `project_image_as_button_conversion.md` documenting the original
  "need AI + flow context" framing. Partially obsoleted once the image
  dynamic-variable PR lands — revisit then.

**Next steps**
1. Wait for Redo image dynamic-variable PR → update `image.ts` parser
2. Re-run `element-viewer image` on UNaeqg and the abandoned-cart templates
   to verify CTA images produce the correct dynamic-variable JSON
3. Move on to the next element in the deep-dive plan (text, header, menu, etc.)

---

## 2026-04-15 — Footer block deep-dive (reversed — keep as Text)

**Done**
- Prototyped FooterBlock end-to-end: parser (`src/parser/blocks/footer.ts`) detecting `kl-text` tds with `{% unsubscribe %}`, renderer (`src/renderer/blocks/footer.tsx`) as MJML analogue of prod `EmailFooter`, dispatcher wire-in, `componentMap` registration, `element-viewer.ts` typeMap entry.
- Verified extraction on 3 templates (QZCq6B, YchdbL, Sz3XHM): font/color/padding round-trip, inner `<div class="textbody">` font overrides (Pontano Sans 12px) picked up.
- **Reversed the plan after reviewing rendered footer alongside Klaviyo source.** Redo's FooterBlock forces its own fixed copy/order ("business name / legal address / city-state-zip / country / Unsubscribe") and destroys Klaviyo's preamble text ("No longer want to receive these emails?") plus any merchant customization.
- Confirmed in redoapp: Redo accepts `{{ unsubscribe_link }}` directly inside Text `text` fields (validated by `hasUnsubscribeLink` in `redo/web/.../unsubscribe-link-warning-modal.tsx` — counts as a legal unsubscribe for compliance). Text blocks preserve original copy/order verbatim.
- Deleted footer parser/renderer/TODO; reverted dispatcher, componentMap, element-viewer typeMap. No new block type added to `types.ts`.
- Rewrote `TODO-SHARED-text.md` PRIORITY 0: inline variable substitution in the export pipeline — `{% unsubscribe %}` → `<a href="{{ unsubscribe_link }}">unsubscribe</a>`, `{{ organization.name }}` and `{{ organization.full_address }}` → merchant-provided values from Klaviyo Accounts API (fallback: user prompt). Placeholders unacceptable.

**Files changed**
- `src/parser/blocks/TODO-SHARED-text.md` — PRIORITY 0 rewritten with inline-substitution plan

**Files created then deleted**
- `src/parser/blocks/footer.ts`
- `src/renderer/blocks/footer.tsx`
- `src/parser/blocks/TODO-SHARED-footer.md`

**Decisions (see DECISIONS.md)**
- Footer-style text blocks stay as TextBlock. No FooterBlock in types.ts. Variable substitution is export-pipeline work, not parser work.

**Memory updated**
- `project_klaviyo_footer_variables.md` + MEMORY.md hook — rewrote from "convert to FooterBlock" to "inline substitution in Text block"

**Next steps**
1. Implement the substitution in the export pipeline (Package E / migration pipeline work).
2. Pull org name + address: try Klaviyo Accounts API first, fall back to user prompt at migration start; store under `manifest.json` `account` key.
3. Audit non-`{% unsubscribe %}` footer patterns (`<kl:unsubscribe-link>`, raw unsubscribe URLs) across the full template corpus.

---

## 2026-04-15 — Socials element deep-dive

**Done**
- Fixed `parseSocialsBlock` against H76ZS6 (`/subtle/` → gray), KT5Xxh (`/default/` → prod-invalid `original`), Kc2UBC (`/subtle/` → gray).
- Prod `SocialIconColor` enum is `black`/`white`/`gray` only — `original` fails Zod validation. Mapping helper now returns `BLACK` for `/default/` Klaviyo CDN icons.
- Color precedence: prefer a specific style (`/subtle/`, `/solid/`, `/white/`) over `/default/` when icons mix within a block, instead of last-icon-wins (fixes the custom-tiktok-image case in KT5Xxh where the last link is a non-Klaviyo asset).
- Alignment extracted from the wrapper's `text-align` inline style (was hardcoded `CENTER`).
- `iconPadding` read from the first icon's `display:inline-block` parent (was last, which frequently has an empty style attribute).
- Replaced `as any` casts with typed output (`SocialItem[]`, `SocialPlatform`, `SocialIconColor`).
- After a parallel integration session landed `ParseContext` + `classifyKlaviyoUrl`, the parser now also runs URL classification on each social `href` for the shared `REVIEW:` / `UNSUPPORTED:` warning pipeline.

**Files changed**
- `src/parser/blocks/socials.ts`

**Decisions (see DECISIONS.md)**
- 2026-04-14 — Socials icon color: lossy mapping to prod enum. `/default/` → `black`. Michael confirmed exact icon color match isn't required for migrations as long as background, URLs, and padding are correct.

**Next steps**
1. Renderer subtracts `iconPadding` from section top/bottom — horizontal gap in Klaviyo, vertical math in the renderer. Works visually today but flag if padding ever looks off.
2. Grep for any remaining `SocialIconColor.ORIGINAL` emissions elsewhere in the parser once the prod Zod alignment in `caf90ad` settles — types.ts still keeps the enum value, so local builder rendering is unaffected, but prod writes must not include it.

---

## 2026-04-15 — Spacer element deep-dive (parser + renderer fix)

**Done**
- Fixed `parseSpacerBlock` — was returning null for Klaviyo spacers because it summed the outer wrapper TD's `padding-top + padding-bottom` (usually 0). Klaviyo actually puts the height in an inner `<div style="height:Npx;line-height:Npx;">` and the background on the inner TD via `background:` shorthand (not `background-color:`). New parser reads the inner div height, sums outer + inner TD padding, and checks inner/outer TD `background` and `background-color`.
- Fixed renderer — `MjmlSection` defaults to `padding: 20px 0`, so a 9px spacer was rendering as 49px. Added explicit `padding="0"` on section/column/spacer.
- Verified via `element-viewer.ts`: Kc2UBC (height=9, #ffffff), QPETZp (height=20, #F8F8F8). Nugivf has no spacers (expected).

**Files changed**
- `src/parser/blocks/spacer.ts` — read inner div height + inner TD background; sum outer+inner padding
- `src/renderer/blocks/spacer.tsx` — explicit `padding="0"` on section/column/spacer

**Note:** Parser signature later refactored to `_ctx: ParseContext` by the concurrent integration session; extraction logic preserved.

**Next steps**
1. **Cross-cutting audit:** `MjmlSection`'s default `padding: 20px 0` likely inflates every block that doesn't explicitly zero or set section padding. Worth a sweep across text/image/button/line renderers.
2. Spacer `sectionPadding` is hardcoded to `{0,0,0,0}`. If a template ever has horizontal padding on the wrapper, swap in `parsePadding(outerStyle)`.

---

## 2026-04-15 — Image element deep-dive + Klaviyo checkout URL mapping

**Context**
Continued the per-element deep-dive from `plans/element-deep-dive.md`. Scope:
`src/parser/blocks/image.ts` and `src/renderer/blocks/image.tsx`. Test fixtures:
Nugivf logo + hero, QP9hma grid-pixel (gxp- variant), QPETZp flow template
(including a 200px centered image), RfTv2d/WyxTcg/SvGNVx/Wyj7Sk cart+checkout
discount templates, UNaeqg checkout-gloves (image-as-CTA design).

**Done — image parser + renderer**
- **Padding-td fallback:** when `kl-img-base-auto-width` class is absent (e.g.
  the QPETZp 200px image's container td has `class=""`), fall back to the td
  containing the `<img>` tag, then to the kl-image td itself. Fixed
  silent-zero-padding parse of images in this shape.
- **Constrained-width centering:** if the image's container td declares an
  explicit `width:` smaller than `EMAIL_MAX_WIDTH_PX - sectionPadding`,
  compute horizontal inner padding to center the image at its native size.
  Fixes QP9hma 560px image (was stretching to 580px; now `padding={10,20,10,20}`)
  and QPETZp 200px image (was stretching to 600px; now `padding={0,200,0,200}`).
- **`showCaption: false`** on all imports (Zod schema requires it).
- **sectionColor fallback** reads `$wrapper.attr("style")` in addition to the
  first td's inline style.
- **Renderer: inner padding now applied.** `EmailImage` threads
  `props.padding` into `MjmlText` padding props; `NestedEmailImage` wraps
  `WithLink` in a div that applies `props.padding`. Previously parsed but
  never rendered.

**Done — Klaviyo checkout URL → Redo dynamic variable**
- Confirmed with Redo team that `schemaInstance.checkoutUrl` is already wired
  end-to-end for button blocks: schema-registered on all four abandonment
  schemas, populated at send time by the abandonment email handler, resolved
  in `button.tsx:268-272`, exposed in the builder's dynamic-variable dropdown.
  Only gap on Redo's side: not yet supported on image blocks.
- Created `src/parser/url-mapping.ts` with `mapKlaviyoLink(url)` returning
  either `{linkType:"dynamic-variable", schemaFieldName:"checkoutUrl"}` or
  `{linkType:"web-page", buttonLink}`. Detects `{{ event.URL }}`,
  `{{ event.CheckoutURL }}`, `{{ event.extra.checkout_url }}` (whitespace +
  Liquid-filter tolerant).
- Wired into `src/parser/blocks/button.ts`. Verified: three abandoned-cart
  templates (XRXjBJ, VGQunZ, XSyzE6) now emit correct dynamic-variable shape;
  static campaign buttons (QP9hma) unchanged.
- Commits `3bea718` (url-mapping hoist + three-state classifier) and
  `caf90ad` (types aligned with prod Zod) landed earlier today.

**External dependency filed**
- Sent Redo's internal AI coder instructions to add dynamic-variable support
  to the image block (mirror of the button work: `clickthroughLinkType` +
  `clickthroughSchemaFieldName` on ImageBlock, renderer resolution via
  `schemaInstance`, builder UI picker). PR will be reviewed later. Once it
  lands, 10-minute parser update in `image.ts` using the same
  `mapKlaviyoLink()` helper will close the loop for the image-as-CTA pattern
  heavy in UNaeqg (9 images, 2 with `{{ event.URL }}` clickthroughs).

**Memory updates**
- Added `project_image_as_button_conversion.md` documenting the original
  "need AI + flow context" framing. Partially obsoleted once the image
  dynamic-variable PR lands — revisit then.

**Next steps**
1. Wait for Redo image dynamic-variable PR → update `image.ts` parser
2. Re-run `element-viewer image` on UNaeqg and the abandoned-cart templates
   to verify CTA images produce the correct dynamic-variable JSON
3. Move on to the next element in the deep-dive plan (text, header, menu, etc.)

---

## 2026-04-15 — Menu block re-visit: bold/italic/underline + HLB split verification

**Done**
- Confirmed HLB split works as designed: `parseHeaderBlock` emits an `ImageBlock` for the logo, `parseMenuFromHeader` emits a `MenuBlock` for the nav links. Verified against `YjRTWe-deal-template` (3 items: Shop Now / Blog / Reviews) and `X57xAh-100-main-template` (3 items, PT Sans). In the 388-template test-account dataset only these two templates have true multi-item HLB menus; the rest are single-CTA "SHOP NOW" style HLBs.
- Added text-style extraction to `parseMenuFromHeader`. `MenuBlock` has no `fontWeight`/`fontStyle`/`textDecoration` fields, so weight/italic/underline are encoded into the label HTML as `<strong>` / `<em>` / `<u>` wrappers (Quill-compatible — the renderer runs `processQuillHtml` over the label).
  - Bold detected when `font-weight` is `bold`, `bolder`, or a numeric value ≥ 600.
  - Example: `YjRTWe` has `font-weight:700` on each link → `<strong>Shop Now</strong>` in the label. `H76ZS6` has `font-weight:400` → unchanged.

**Files changed**
- `src/parser/blocks/menu.ts`

**Decisions**
- Encode bold/italic/underline in label HTML rather than adding new `MenuBlock` fields — simpler, matches Quill conventions the renderer already processes.

**Next steps**
1. Per-item font styling divergence (different weight across items in the same menu) is currently collapsed — first link's style is used for block-level `fontFamily`/`fontSize`/`linkColor`; per-item tags only vary weight/italic/underline. If a real template ships mixed per-item styling this can become visible.

---

## 2026-04-15 — Status check only

**Done**
- Session-start status check (branch clean, last commits from 2026-04-14 integration session).
- Out-of-repo: seeded `~/.claude/TODO.md` global backlog with https://github.com/forrestchang/andrej-karpathy-skills and added a read-trigger in `~/.claude/docs/session-protocol.md` so TODOs surface at every session start.

**Files changed (this repo)**
- None.

---

## 2026-04-21 — Button element deep-dive

**Done**
- Pixel-correct button parsing across transactional (Shopify), abandoned cart, modern campaigns, discount giveaway, newsletter, gift card, and password reset templates
- **sectionPadding fix**: was reading from `kl-button` td (always 0); now navigates up to outer wrapper td via `$td.closest("table").parent("td")`
- **Stroke extraction**: new `parseBorderStroke` only emits uniform stroke when all four border sides match. Klaviyo's shadow pattern (`border:none; border-bottom:solid 2px ...`) correctly drops to transparent/0 instead of painting a 4-sided border
- **Fill color fallbacks**: added `background-color` / `background` from both bgTd style and `<a>` style
- **Full-width detection**: checks `width:100%` on inner table or `<a>` tag
- **Three-state link classification** for Klaviyo `{{ }}` variables in button hrefs:
  - Known-mapped (via `mapKlaviyoLink`) → dynamic-variable (e.g. `event.URL` → `checkoutUrl`)
  - Explicitly unsupported (`UNSUPPORTED_VARIABLES`) → `UNSUPPORTED:` warning → template routes to manual migration
  - Unknown/new variable → `REVIEW:` warning → surfaces on review list for user to classify later
- Explicitly unsupported variables: `gift_card.*`, `customer.reset_password_url`, `customer.account_activation_url`, `fulfillment.tracking_urls*`, `tracking_url`
- Created `src/parser/blocks/TODO-SHARED-button.md` with prioritized followups

**Templates tested**
- `Hda2jD-shopify-customer-account-activation` — standard Shopify transactional, shadow border
- `KT5Xxh-shopify-shipping-confirmation` — 2 buttons, tracking URLs
- `Kc2UBC-newsletter-7-snack` — organization.url (REVIEW)
- `RQiCcF-discount-giveaway` — full-width, custom font (Alegreya Sans Bold), cornerRadius 9
- `QFmzAC-shopify-gift-card-notification` — gift_card.url (UNSUPPORTED)
- `QP9hma-grid-pixel-campaign-dec-22-2025-last-chance-for-epic-gifts` — gxp-kl-button variant, pill shape (cornerRadius 40)
- `Ly82ir-shopify-customer-password-reset` — reset_password_url (UNSUPPORTED)
- `VGQunZ-ac-template` — abandoned cart, event.URL mapped to checkoutUrl
- `S3stYS-grid-pixel-campaign-2-no-discount-new-arrivals-v2-modern` — ghost/outlined button (white fill, black 1px 4-sided border), full-width

**Known limitations (documented in TODO-SHARED-button.md)**
- Full-width button horizontal padding: Klaviyo zeroes it in HTML during MJML compile, original value unrecoverable
- Custom fonts (Alegreya Sans, Inter, etc.) extracted verbatim — need normalization layer (cross-cutting)
- font-weight, letter-spacing, text-transform silently dropped (no Redo schema fields)
- UNSUPPORTED/REVIEW prefix convention on warnings needs proper `ParseResult` fields once dispatcher is unfrozen

**Files changed**
- `src/parser/blocks/button.ts` — rewrote parser (sectionPadding, stroke, fill, full-width, link classification)
- `src/parser/blocks/TODO-SHARED-button.md` — created, prioritized followups
- `plans/element-deep-dive.md` — added followup pointer under Button section

**Note:** After this session, a separate integration session hoisted `classifyKlaviyoUrl` into `url-mapping.ts`, updated button.ts to use `ParseContext`, and aligned renderer types with prod Zod schemas (commits `3bea718`, `caf90ad`, `b650051`).

---

## 2026-04-21 — Package E5: drop-shadow asset URL placeholder + Replit hosting decision

**Done**
- Replaced `DROP_SHADOW_LOCAL_PATH = "pics/drop-shadow.png"` in `src/parser/blocks/klaviyo-specific.ts` with `DROP_SHADOW_URL = process.env.DROP_SHADOW_URL ?? "https://PLACEHOLDER.replit.app/drop-shadow.png"`. Env-var override is the intended Replit override mechanism (set in Secrets after deploy, no code change).
- Researched two paths: (a) Redo CDN via `@redotech/s3` `uploadFile` from a `redo/manage` script (modeled on `support/upload-shopper-ai-wrapped-images.ts`), or (b) Replit Static Deployment serving the bundled PNG. Picked (b): mime ships to Replit anyway, free for tiny bandwidth, no need to touch Redo's prod S3 buckets, stable URL across redeploys.
- Updated `TODO-SHARED-klaviyo-specific.md` Priority 0 to "Set DROP_SHADOW_URL env var on Replit" with steps for deploy + env-var setup + a still-unimplemented runtime guard that fails loud if URL is still PLACEHOLDER.
- Memory: new `project_drop_shadow_asset_hosting` entry indexed in MEMORY.md.

**Files changed**
- `src/parser/blocks/klaviyo-specific.ts` — env-var override pattern
- `src/parser/blocks/TODO-SHARED-klaviyo-specific.md` — Priority 0 retitled and rewritten

**Branch / commit**
- Worktree: `.claude/worktrees/trusting-carson` on `claude/trusting-carson`
- Commit: `6c22a75 fix(klaviyo-specific): drop-shadow URL placeholder for Replit deploy` — pushed to origin
- Concurrent uncommitted work in the worktree (E3's `_fontPlan` integration in `export-template.ts`, `src/fonts.ts`, `src/migrate/`, etc.) deliberately left untouched; staged by explicit path

**Decisions (see DECISIONS.md)**
- Drop-shadow asset hosted from mime's Replit static deployment, NOT Redo's S3 / `assets.getredo.com`. Env-var override (`DROP_SHADOW_URL`) is the deploy-time switch.

**Next steps**
1. When mime is deployed to Replit, set `DROP_SHADOW_URL` in Replit Secrets to the real URL. No code change needed.
2. Add the runtime guard from TODO-SHARED-klaviyo-specific.md step 3 (throw if `DROP_SHADOW_URL` still resolves to PLACEHOLDER) before any prod migration runs.
3. Sanity-check by sending a parsed template with a drop-shadow block to a Gmail inbox after deploy.

---

## 2026-04-15 — Klaviyo-specific blocks wired into dispatcher (video / preview quote / drop shadow)

**Context**
`src/parser/blocks/klaviyo-specific.ts` existed as a standalone module from the
2026-04-14 parallel deep-dives but was never dispatched. Wrapped up by wiring
`tryParseKlaviyoSpecific` into `parseColumnContent` so the three Klaviyo-only
block types stop falling through to the "Unknown block type" warning.

**Done**
- **Dispatcher wiring:** `tryParseKlaviyoSpecific` now runs first inside
  `parseColumnContent` (before `kl-image` matching, so drop-shadow imgs don't
  get misrouted to the image parser). `bodyBackgroundColor` threaded via a
  bound closure so `column.ts`'s callback signature stays frozen per the
  per-element plan.
- **Detectors:** `kl-video` class → video; `kl-review-gutter` inside wrapper
  OR wrapper class matches `kl-review-*` → preview quote;
  `img[src*=bottom_shadow_]` → drop shadow. Drop shadow additionally requires
  a white body background (`#fff / #ffffff / white / rgb(255,255,255) /
  rgba(255,255,255,1)`).
- **ParseContext integration:** all three paths push structured entries onto
  `ctx.skippedBlocks` with `blockType` + `reason` (follow-on to the
  ParseContext refactor — no more `SKIPPED:` / `REVIEW:` prefix strings).
- **Drop-shadow asset path:** `imageUrl` reads from `DROP_SHADOW_URL` env var
  with a PLACEHOLDER Replit URL fallback, so local dev still produces valid
  JSON and Replit can override via Secrets post-deploy.
- **TODO-SHARED-klaviyo-specific.md:** documents the CDN upload flow, the
  env-var override mechanism, and an early guard we should add so a
  misconfigured deploy fails loud.

**Smoke test**
On `migrations/merchant-2/templates/H76ZS6-newsletter-4-story-boxes.html`
(contains all three patterns): video → skipped, preview quote → skipped,
two drop shadows → skipped with REVIEW reason (body bg `#f7f7f7`, not white) —
correct branch.

**Files changed**
- `src/parser/blocks/klaviyo-specific.ts` (new module, then ctx refactor + URL placeholder)
- `src/parser/blocks/TODO-SHARED-klaviyo-specific.md` (new)
- `src/parser/index.ts` — dispatcher wiring + bound closure for `bodyBackgroundColor`

**State at session end**
- Branch: `main`, clean (code committed in `a349dcd`, `9375c37`, `caf90ad`, `6c22a75`).
- `DROP_SHADOW_URL` still `PLACEHOLDER` — blocks prod imports until the Replit
  static deploy is up and the env var is set (tracked in TODO-SHARED Priority 0).

---

## 2026-04-15 — Column element deep-dive (parser + renderer)

**Context**
Column element from `plans/element-deep-dive.md`. Scope restricted to
`src/parser/blocks/column.ts` and `src/renderer/blocks/column.tsx`. Test
templates: H76ZS6 (4 story boxes), KgEaX2 (icons + headlines via kl-split),
Lgdf7J (3-column images), plus QPETZp (product inside multi-col row) for the
bail path.

**Done**
- **Parser (`column.ts`)**
  - `stackOnMobile` now read from parent `kl-row.colstack` class (was hardcoded `true`).
  - `alignment` extracted from `kl-column`'s `vertical-align` style (was hardcoded TOP).
  - `sectionColor` walks up parent chain looking for bg-color (was matching the wrong element and defaulting to white).
  - Multi-column row now returns `Section[]` (not `ColumnBlock | null`). Stacked wrappers zippered across columns into K stacked ColumnBlocks; padding clamped so non-first rows zero the nested block's top padding and non-last rows zero its bottom padding — stacked sections visually touch.
  - Bail-out on non-nestable content: if any column contains a block outside {TEXT, IMAGE, BUTTON, DISCOUNT} (e.g. a product block that comes through as a nested ColumnBlock from `parseProductBlock`), flatten every inner block into standalone top-level sections. Products render as standalone Redo product blocks; sibling column content becomes standalone sections. Matches user rule: "if products are in columns, just use the product block."
  - `parseSplitBlock`: sectionColor walks parent chain; alignment from vertical-align.
  - `parseSplitSubblock`: handles buttons (kl-button) → images (with src) → text fallback; preserves subblock padding from `td.spacer`; returns a single `NonRecursiveBlock | null`.
- **Renderer (`column.tsx`)**
  - Fixed React "missing key" warning by wrapping each mapped column in `<Fragment key={index}>`.
  - Gap spacer column only rendered when `gap > 0` (avoids 0%-width MJML columns).
- **Dispatcher (`src/parser/index.ts`)** — one-line change: `sections.push(...rowSections)` in the multi-column branch, to accommodate `parseColumnRow` returning an array. (Touched with explicit permission from the user; otherwise in-scope for column work.)

**Verified**
- 4 templates via `src/element-viewer.ts column …`: 12 column blocks render cleanly, no React warnings.
- H76ZS6: 2 stacked column sections (was 1) — both text content preserved in zipper.
- QPETZp (product in multi-col row): bail path fires, product emits standalone.
- KgEaX2 (5 kl-splits) + Lgdf7J (1 single-row 3-col): unchanged.

**Known gaps**
- Zipper untested with real image content — test templates had src-less placeholder `<img>` tags, so the image+text zipper only exercised text blocks. Spot-check against a real story-box campaign when one surfaces.
- `parseSplitSubblock` still picks one block per subblock (button > image > text priority). If a kl-split subblock ever contains stacked content, extras get dropped. Low-priority — kl-split is designed as single-content-per-side.

**Memory saved**
`project_column_architecture.md` — zipper + bail-on-product rationale, nestable set, dispatcher contract.

**State at session end**
- Branch: `main`, clean vs origin. Column source changes landed upstream under `parser: cart-template fixes + defensive regression anchors` (commit `623d5e1`), which also refactored parser signatures to use `ParseContext` — so the function signatures documented in the memory are slightly outdated (now take `ctx: ParseContext` instead of `warnings: string[]`) but the architecture stands.

---

## 2026-04-15 — Line block deep-dive

**Context**
Parallel element-deep-dive track for the LINE block. Files in scope:
`src/parser/blocks/line.ts`, `src/renderer/blocks/line.tsx`. Test templates:
H76ZS6-newsletter-4-story-boxes, Hda2jD-shopify-customer-account-activation,
K4ca2Z-shopify-refund-notification.

**Done**
- Ran `npx tsx src/element-viewer.ts line …` against the 3 test templates.
  All three use the same Klaviyo structure: outer TD `padding:0 14px 0 14px`
  with `background:#fff`, inner TD `padding:0`, `<p>` with
  `border-top:solid 4px #3d3935`.
- Parser was already extracting sectionPadding, sectionColor, and color
  correctly. Gaps: inner TD padding wasn't parsed (MjmlDivider's default
  `10px 25px` was bleeding through) and thickness was dropped (renderer
  hardcoded 2px — source is 4px).
- Parser now reads the inner TD style and returns `innerPadding`; renderer
  passes it to MjmlDivider's padding props to suppress the MJML default.
- Added `thickness` as a parser-only extra (via type intersection, since
  types.ts is frozen during parallel work) so the renderer could draw 4px.
  Verified all 3 templates now render `border-top:solid 4px #3d3935`.

**Decision: accept Redo's line-schema gap**
Redo's `LineBlock` Zod schema has no `thickness` or `borderStyle` field —
all lines are fixed-thickness solid. Our `thickness` extra worked locally
but gets stripped on API round-trip. Decided not to build a rasterization
fallback (render >3px or non-solid lines as ImageBlock) until a real
migration surfaces a template where it matters. Captured as
`project_line_schema_gap` memory.

**Post-session note**
Track 1's types-alignment refactor (commit `caf90ad`) landed after this
session, adding `Size.CUSTOM` / `horizontalPadding` / `verticalPadding` to
`LineBlock` and dropping the local `thickness` extra. Renderer reverted to
`borderWidth={2}` — consistent with the accepted schema gap. `innerPadding`
survived as the canonical `padding` field.

**State at session end**
- Branch: `main`, clean.
- Line parser/renderer now match Klaviyo on color, sectionColor,
  sectionPadding, and inner padding; thickness snaps to Redo's default.

---

## 2026-04-21 — Header block status check (no-op)

Quick check-in on header element work. `git diff --stat main` clean — working tree has nothing uncommitted. Confirmed via git log that `parseHeaderLogoAsImage` rename (Package F) and prod Zod alignment (`caf90ad`) have landed on main. Header block work is confirmed complete; the earlier 2026-04-14 entry covers the substantive design decision.

No code changes this session.

---

## 2026-04-21 — Package D: parsePadding bug fix + renderer padding audit

**Context**
Work Package D from `plans/consolidated-todos.md`. Two tasks: D1 upstream the
`parsePaddingWithOverrides` bug fix into `style-utils.ts`, D2 audit every
renderer for MjmlSection default padding inflation.

**Done**
- **D1 (committed `6d76162`):** Replaced `parsePadding` in
  `src/parser/style-utils.ts` with the CSS-cascade-correct version that was
  living as `parsePaddingWithOverrides` in `text.ts`. The old version returned
  early on shorthand `padding`, silently ignoring individual `padding-*`
  overrides (common in Klaviyo: `padding: 0px; padding-top: 18px`). Deleted
  the local workaround in `text.ts`, switched its call to the shared
  `parsePadding`. All callers across image, button, column, header, line,
  menu, socials, product, klaviyo-specific now get the fix for free.
- **D2 (no changes needed):** Audited every `src/renderer/blocks/*.tsx`
  (excluding text.tsx and line.tsx per Track 1 ownership). Every in-scope
  MjmlSection already explicitly sets `paddingTop/Bottom/Left/Right` from
  `sectionPadding` props. Verified via MJML output inspection that individual
  padding attributes come after the default shorthand (`padding:20px 0`) and
  win via CSS cascade. Spacer uses `padding="0"` shorthand which suppresses
  the default entirely; other blocks use individual attributes which override
  it — both approaches are correct.

**Batch-test:** 416 total, 0 failures (confirmed after both D1 and D2).

**State at session end**
- Branch: `main`, 1 commit ahead of origin.
- Uncommitted changes in working tree from concurrent Track 1 work (Package A
  warnings refactor + `sumAncestorPadding`/`findAncestorBackgroundColor` added
  to style-utils.ts). Those are not part of this session's scope.

---

## 2026-04-21 — Import script review (brief)

**Context**
Quick revisit to check on import-klaviyo-templates.ts status and history.

**Done**
- Confirmed import script last touched 2026-04-17 (commit `252b2582fd7`), which added brand-kit font syncing (`syncFontPlansToBrandKit`), `_fontPlan` handling, filter dedup, and `TeamRepo` + `CustomFontFamily` imports.
- Script now significantly larger than the 2026-04-14 scaffold: font plan interfaces, weight-to-family-suffix convention, brand-kit merge logic, excluded weights (700/800).

**State at session end**
- No code changes this session — review only.
- Branch: `main`, clean.

---

## 2026-04-21 — Packages A + B + C: shared-file refactor (warnings → URL classifier → types.ts)

**Context**
Three sequential packages from `plans/consolidated-todos.md`, done in order so
later work could build on earlier changes. Track 1 ownership; did not touch
`style-utils.ts` or renderers outside `line.tsx` / `text.tsx` / `index.tsx`.

**Done**
- **Package A — warnings system refactor (`9375c37`).** Replaced the
  `UNSUPPORTED:` / `REVIEW:` / `SKIPPED:` prefix convention on
  `warnings: string[]` with structured arrays on `ParseResult`:
  `unsupportedFeatures: UnsupportedFeature[]`, `reviewItems: ReviewItem[]`,
  `skippedBlocks: SkippedBlock[]`. Introduced `ParseContext` (warnings + the
  three structured arrays) and threaded it through every block parser
  signature (`warnings: string[]` → `ctx: ParseContext`). `button.ts` and
  `klaviyo-specific.ts` push to the new arrays; other blocks still use
  `ctx.warnings` for general info. `export-template.ts` prints each category
  separately.
- **Package B — URL classifier hoist (`3bea718`).** Moved `classifyVariable`
  / `extractVariableName` / `UNSUPPORTED_VARIABLES` out of `button.ts` and
  into `url-mapping.ts`. New `classifyKlaviyoUrl(url, blockType, ctx)` helper
  returns the `MappedLink` and simultaneously pushes unsupported/review
  entries. Called from button, image clickthrough, menu item hrefs, social
  URLs, and header logo clickthrough — so any URL-carrying block surfaces
  unknown Klaviyo variables on the same review list.
- **Package C — types.ts expansion (`caf90ad`).** Aligned `renderer/types.ts`
  with prod Zod schemas:
  - `EmailBlockType.PRODUCTS = "interactive-cart"` (was a `Record<string,...>`
    shim in `renderer/index.tsx`; now `Record<EmailBlockType,...>`).
  - `Size` enum + required `horizontalPadding`/`verticalPadding` on Image and
    Line; parser emits `Size.CUSTOM` everywhere.
  - `ImageType` enum + optional `imageSourceType` on Image.
  - `showCaption` promoted from optional to required.
  - `lineHeight?` / `textAlign?` added to TextBlock; parser emits them as
    structured fields, renderer reads from props instead of HTML-embedded
    `<div style="line-height: …">` / `<p style="text-align: …">` workarounds.
  - Lifted `ProductsBlock`, `InlineButton`, `ProductFilterDoc`,
    `ProductImageSize`, `ProductLayoutType`, `ProductSelectionType`,
    `ManuallySelectedProduct` from `parser/blocks/product.ts` local shims into
    `renderer/types.ts`. `ProductsBlock` now extends `BaseBlock` and
    participates in the `Section` union; `product.ts` no longer needs the
    `as unknown as Section` cast.
  - Dropped `ParsedLineBlock` shim: `innerPadding` collapses into
    `LineBlock.padding`, `thickness` is hardcoded to 2 in `line.tsx`.
  - Dropped `SocialIconColor.ORIGINAL` (prod only has black/white/gray); the
    "original" Klaviyo colorful icon set already mapped to BLACK at parse
    time, so behavior unchanged.
  - Added `[EmailBlockType.PRODUCTS]: undefined` to `nested-email-blocks.tsx`.

**Batch test**
`npx tsx src/parser/batch-test.ts` after each package:
- Baseline: 416 total, 94 clean, 322 warned, 0 failed
- After A: 416 / 104 / 312 / 0 (clean count up because SKIPPED/REVIEW/UNSUPPORTED entries no longer land in `warnings[]`)
- After B: 416 / 104 / 312 / 0
- After C: 416 / 104 / 312 / 0

**Typecheck**
`npx tsc --noEmit` shows only the same pre-existing errors (cheerio `AnyNode`,
`amp-img` JSX, missing `mjml` types). No new errors introduced by any of the
three packages.

**State at session end**
- Branch: `main`, 3 commits ahead of origin (A + B + C).
- No uncommitted code changes.
- Packages D and F1 already landed in earlier sessions. Package G (import
  executor) can now read the structured `unsupportedFeatures`, `reviewItems`,
  and `skippedBlocks` arrays directly instead of string-prefix grepping.

---

## 2026-04-20 — CODE-template parser (editor_type: CODE) — first pass, paused

**Context**
Klaviyo's `editor_type: CODE` templates are hand-coded HTML emails that don't
use the block editor, so the existing `kl-*` / `gxp-kl-*` class-dispatch
parser returns 0 sections. Otishi (new merchant evaluating Redo) has 368 of
these out of 464 total templates (80%). Previous session noted this as a
coverage gap (`project_coverage_gaps`) with no concrete plan.

**Done**
- **Survey:** pulled Otishi's Klaviyo corpus via `extract-templates.ts`
  (464 templates total, 368 CODE + 96 SYSTEM_DRAGGABLE). Structural audit
  showed CODE templates are *not* wildly variable — 367/367 use a
  `max-width:600px` wrapper, 363/367 use inline styles, 0 use MJML. The
  dominant pattern is a 600-pixel email table with `<tr>` rows each
  carrying one visual block (header, text, button, divider, footer, etc.).
  The original assumption that CODE = "wildly variable hand-coded HTML"
  was wrong; corrected mid-session after Michael pushed back on the
  speculation.
- **Parser built — `src/parser/code-template.ts` (~780 lines).** Two
  container modes:
  1. **Table-based (272/368):** find `<table>` with `max-width:600px`
     or `width="600"`, iterate its direct `<tr>` rows. For each row's
     `<td>`, walk direct children, accumulate text-like nodes (p, h1-h6),
     flush on block-breaking elements (img, table, hr).
  2. **Div-based (96/368):** fallback for Hypermatic/Stripo/MSO-wrapped
     templates where the wrapper is `<div style="max-width:600px">`
     instead of a table. A `deepWalkContent` DFS descends through
     wrapper divs/tables, emits blocks as recognizable shapes are found,
     skips display:none preheader spans.
  - Classifier emits BUTTON / IMAGE / TEXT / LINE / COLUMN / SPACER
    from structural shape (nested `<table>` with `<td style="background-color;
    border-radius;">` + `<a>` = button; `<a><img></a>` with no other
    content = image with clickthrough; `<td style="border-top">` alone =
    line; multi-td `<tr>` = column).
  - Multi-block column cells bail to flat emission (matches the existing
    Klaviyo parser convention — stacked ColumnBlocks break mobile reflow).
  - Wired into `src/export-template.ts`: routes `editor_type: CODE`
    (or heuristically, templates with zero `kl-*` classes) through the
    new parser; block-editor templates keep the existing path.
- **Test harnesses** (`src/parser/code-template-{smoke,warnings,debug,emit}.ts`)
  for batch regression, warning categorization, quality-stat dumps, and
  Section[] JSON emission for the side-by-side viewer.
- **Anthropic SDK dynamic import:** `src/ai-rewrite.ts` switched from
  static `import Anthropic from "@anthropic-ai/sdk"` to dynamic
  `await import(...)` inside the client factory. Unblocks running the
  pipeline without the package installed (e.g. `SKIP_AI=1`). Had to add
  a `@ts-expect-error` on the dynamic import because the type is
  optional-peer.
- **End-to-end push validated:** exported `T4NcCW-46-gym-vs-home-gym`
  through the mime pipeline and imported into local Mime team
  (`69dff28302f64f42e6012a4d`) via
  `bazel run //redo/manage:import-klaviyo-templates`. Template ID
  `69e6b4fcd97242a7998d7e71`. 0 errors.
- **Batch metrics across 368 Otishi CODE templates:**
  - 0 parse failures, 0 empty outputs
  - 4,211 sections total (text: 1660, image: 1251, button: 712,
    line: 467, column: 66, spacer: 55)
  - 141 warnings, breakdown:
    - 96 "couldn't find 600px container; deep-walking body" (fallback
      path used; 80 of those produced usable output, 16 produced ≤2
      sections and are genuinely broken — CSS-class-based div templates
      that need `<style>` block resolution)
    - 45 "multi-block column cell; bailing to flat section emission"
      (side-by-side product-card rows)

**Decision: pin the project**
Spot-checked the imported template in the local Redo builder and in
the side-by-side viewer. Block detection is right (images, buttons,
headings all mapped correctly), but visual fidelity is poor enough that
Michael doesn't want to ship it. Known issues seen in the builder:
- **Image widths don't survive.** Mime emits ImageBlock with aspectRatio
  but Redo uses `horizontalPadding: small|medium|large` (size buckets,
  not pixels), so a 160px logo renders full-width.
- **Column gap rendering differs.** Original used `border-radius:6px 0 0
  6px` / `0` / `0 6px 6px 0` to visually join three cells; Redo's
  ColumnBlock adds a gap regardless of `gap: 0`.
- **Generic text-block styling** (fontFamily, fontSize, color) is read
  from the first child's inline style, which misses per-span overrides
  inside a `<td>` that has multiple differently-styled `<p>`s stacked.

This is solvable but amounts to a separate project — probably weeks of
iteration against the Otishi corpus. Parking until then. Work-in-progress
merge is safe to commit because it's gated behind `editor_type: CODE` /
no-kl-class heuristic; existing block-editor migrations are unaffected.

**Files created/changed**
- `src/parser/code-template.ts` (new, 780 LoC) — CODE template parser
- `src/parser/code-template-smoke.ts` (new) — batch smoke test
- `src/parser/code-template-warnings.ts` (new) — warning tally
- `src/parser/code-template-debug.ts` (new) — per-template quality stats
- `src/parser/code-template-emit.ts` (new) — emit Section[] JSON for viewer
- `src/ai-rewrite.ts` (modified) — dynamic Anthropic import
- `src/export-template.ts` (modified) — route CODE templates to new parser

**State at session end**
- Parser: 368 Otishi CODE templates + 416 test-account templates, 0 regressions
- CODE parser working but visual fidelity insufficient → paused
- `src/migrate/import-rpc.ts` referenced in git status at session start
  was missing by the time I looked — appears to have been deleted between
  session start and my first check (untracked file, so no git history)
- Branch: `main`, clean apart from commits being made at wrap-up

**Next steps (when this picks back up)**
1. Image width preservation — investigate whether ImageBlock has any
   pixel-level sizing or whether we need to pre-compute a
   `horizontalPadding` bucket from the image's explicit width and the
   600px email width (small/medium/large maps to some padding table).
2. Column gap rendering — read Redo's ColumnBlock rendering to see
   whether `gap: 0` is respected and what controls the visual gap.
3. Text fragment per-span styling — instead of reading the first child's
   style, descend into spans when a `<td>` has a single homogeneous
   styled block; emit the full styled HTML and let Redo's Quill strip it
   appropriately.
4. CSS-class-based templates (16 templates, ~4%) — parse `<style>`
   block, resolve class selectors to inline properties before walking.
   Alternatively skip with warning since it's a small slice.
5. Multi-block column cells — consider side-by-side product-card
   emission strategies (separate image block row + text block row,
   or a real ColumnBlock with image only, or waiting for Redo to support
   nested columns).
---

## 2026-04-21 — Package E3: font provisioning pipeline (mime side)

**Done**
- **`src/fonts.ts` (new):** `collectFonts(sections)` walks all block types — text + text.inline spans, button, discount, menu, header, products (incl. nested `checkoutButton` / `lineItemButtons` InlineButton), ColumnBlock recursion — returning deduped `FontUsage[]` with per-site usage. `resolveGoogleFont(family)` probes Google Fonts CSS2 API (no API key, modern UA for WOFF2). Literal-first casing with title-case fallback so "PT Sans" (brand mixed-case) and "OSWALD" (all-caps) both resolve. `buildFontPlan(sections)` combines collect + resolve into `{ entries, hasUnresolved }`.
- **`src/export-template.ts`:** attaches `_fontPlan` to the exported EmailTemplate (same non-prod convention as `_pendingFilter` on products). Prints per-font status in the export summary.
- **Corpus audit (804 templates):** 15 unique custom fonts. 7 resolve on Google Fonts (Alegreya Sans — 695 uses / 348 templates — Inter, Oswald, PT Sans, Pontano Sans, Bodoni Moda, Questrial). 8 don't (typos: "Alegrey extra", "potano sans", "TimesNewRoman"; weight-as-family aliases: "Alegreya sans bold"; Apple system fonts: "New York", "Baskerville").
- **Memory update (contradicted doc):** `reference_brand_kit_font_upload.md` previously said "migration script does NOT programmatically upload fonts". Reversed today — new path is auto-upload for Google-Fonts-resolvable, block-with-per-font-error for unresolvable. Rewrote the reference with explicit history, updated `project_migration_human_input_ux.md` touchpoint #6, updated `MEMORY.md` index entries.
- **Commit hygiene:** stashed E2's in-progress `transform.ts`/`ai-rewrite.ts` and E4's files before committing so `16c5378` contains only `src/fonts.ts` + `src/export-template.ts`. Restored stashed work after push.

**Files changed**
- `src/fonts.ts` (new, 272 lines)
- `src/export-template.ts` (import + `buildFontPlan` call + `_fontPlan` field + console output, +20 lines)
- Memory: `reference_brand_kit_font_upload.md` rewritten, `project_migration_human_input_ux.md` touchpoint #6 updated, `MEMORY.md` index entries updated

**Commits on `claude/trusting-carson`** (pushed)
- `16c5378` feat(fonts): E3 — Google Fonts resolver + `_fontPlan` emission

**Decisions**
- **Auto-upload with preflight-block fallback** (reverses 2026-04-14 preflight-only). Rationale: Google Fonts is the canonical source with OFL licensing — no ambiguity about what gets uploaded. If a font isn't on Google Fonts, importer still blocks with a clear per-font error. Best of both paths.
- **`_fontPlan` embedded per-template** (not aggregated at migration level). Importer aggregates across templates when it runs. Matches `_pendingFilter` convention.
- **Literal-first casing with title-case fallback** in the resolver — preserves brand casing like "PT Sans" while still recovering inconsistent casing like "OSWALD" → "Oswald". Brute-force normalization would break brand names.

**State at session end**
- Branch: `claude/trusting-carson`, pushed.
- Packages complete: A, B, C, D, F, E1, E2, **E3**, E4, G.

**Next steps**
1. **Redoapp-side E3** (new session): `~/code/redoapp/redo/manage/src/import-klaviyo-templates.ts` consumes `template._fontPlan` before `EmailTemplateRepo.createTemplate`: auto-upload resolved fonts via `uploadFile → processFontFiles → TeamRepo.updateBrandKit`, hard-fail per-font on unresolved, strip `_fontPlan` before saving. Mirrors existing `_pendingFilter → recommendedProductFilterId` swap pattern.
2. E5: drop-shadow CDN upload (or move `drop-shadow.png` to mime Replit deploy per `project_drop_shadow_asset_hosting` memory).
3. Merge `claude/trusting-carson` to main.

---

## 2026-04-21 — Package E2: inline coupon → AI text rewrite + placeholder discount block

**Done**
- **`src/ai-rewrite.ts` (new)** — portable `@anthropic-ai/sdk` client that works on Replit (`AI_INTEGRATIONS_ANTHROPIC_BASE_URL` + `AI_INTEGRATIONS_ANTHROPIC_API_KEY` env vars) and locally (`ANTHROPIC_API_KEY`) with zero code changes. Single concrete implementation — no `LLMClient` abstraction layer; the SDK is the abstraction.
- **Model: `claude-sonnet-4-6`** with system-prompt `cache_control: ephemeral`. System prompt is static across all rewrites in a migration → first call writes the cache (~1.25×), subsequent calls within 5 min read it (~0.1×).
- **System prompt** instructs the model to: (a) remove the `{% coupon_code %}` variable, (b) restructure the sentence so it flows into a discount block that will be inserted immediately below, (c) preserve all HTML tags/inline styles, (d) keep other liquid variables intact (`{{ person.first_name }}`, etc). Three few-shot examples in the prompt cover the most common phrasings.
- **`src/transform.ts`** — converted to async. Text-block handler now: (1) runs E1 variable substitution, (2) detects surviving `{% coupon_code %}` via `hasInlineCoupon`, (3) calls `rewriteInlineCoupon`, (4) emits `[rewrittenText, placeholderDiscountBlock]`. The placeholder DiscountBlock is styled from the text block's own fields (inherits `fontFamily`, `textColor`, `sectionColor`, `sectionPadding`) with `fontSize: 32`, `alignment: center`, no `discountId` (wired later in the import executor).
- **flatMap at the top level** (`for` loop building `out[]` with `push(...transformed)`) so a single input block can emit multiple output blocks. One-to-many `transformBlock` signature is the key change.
- **Column cells: intentionally skipped.** ColumnBlock holds a single block per column — can't splice a discount block as a sibling inside a column. Logs a console warning when detected; AI still rewrites the text in the cell.
- **Rule-based fallback when AI is off.** When `SKIP_AI=1` (or no API key set), `ruleBasedStripInlineCoupon` deterministically excises the common `"USE CODE {% coupon_code 'X' %} FOR N% OFF"` phrase and still emits a discount block. If the phrase doesn't match the regex, the coupon stays in the text (merchant cleans up manually) and a discount block is still appended. Every inline-coupon template produces a discount block whether or not the AI ran.
- **`src/export-template.ts`** — awaits the async transform, reports `aiRewrites` count + token usage (input / output / cache read / cache write) in the console summary.
- **`transformSections(sections, account | null, opts)`** — `account` can now be null (when Klaviyo API fetch fails or `KLAVIYO_API_KEY` is missing). Variable substitution gates on the presence of each org field; coupon detection + rewrite still run. Missing-key fallback no longer drops discount blocks entirely.

**Files created/changed**
- `src/ai-rewrite.ts` (new)
- `src/transform.ts` — async, coupon-rewrite pipeline, null-safe account, rule-based AI-off fallback
- `src/export-template.ts` — await transform, report AI usage
- `package.json` — `@anthropic-ai/sdk` dep added

**Decisions (see DECISIONS.md)**
- No `LLMClient` abstraction layer. Replit's "AI Integrations" is standard Anthropic SDK + auto-provisioned env vars — same code runs both places.
- Placeholder `DiscountBlock` from parser + transform does NOT carry `discountId`. Real discount object linking happens in the redoapp import executor, not in mime's export.
- Inline-coupon rewrite removes the variable AND always inserts a placeholder discount block below — single-path, deterministic structure. The text's AI rewrite assumes a block below; no branch for "maybe keep the variable".

**Verified**
- Dry run on `test-account/RfTv2d-cart-discount-1.html` (single-coupon, body-copy only) — `SKIP_AI`/no-key path emits rule-based strip + discount block cleanly; warnings suppressed; font plan still runs; section count goes from 10 → 11 (discount block inserted).
- Type-check (`npx tsc --noEmit`) — no new errors in `ai-rewrite.ts` / `transform.ts` / `export-template.ts`.

**Not done (deferred)**
- Live AI run — Michael holding the Anthropic key. All 4 inline-coupon templates (`RfTv2d`, `SvGNVx`, `XJkGxs`, `YyKZYQ`) ready to smoke-test once a key is available.
- Real Redo discount-object creation + `discountId` wiring. Out of scope: belongs in the redoapp import executor since it needs team-scoped API auth and a discount already exists.
- URL-param inline coupons (`href="...?discount={% coupon_code 'X' %}"` — observed in grid-pixel templates) not handled this pass. Separate liquid-substitution concern.

**Next steps**
1. User provides Anthropic key → run the 4 inline-coupon templates end-to-end, eyeball the rewrites in element-viewer.
2. If the Sonnet 4.6 output needs tuning: iterate the system prompt (more examples, stricter tone-preservation instructions).
3. Wire the discount-object creation step into the redoapp import executor (`~/code/redoapp/redo/manage/src/import-klaviyo-templates.ts`). Input: parsed `DiscountBlock` with no `discountId` + migration-config prefix + inferred amount. Output: `DiscountBlock` with real `discountId`.

---

## 2026-04-21 — Package E4: REVIEW list aggregator + two url-mapping gap fixes

**Done**
- **E4 aggregator** `src/migrate/review-variables.ts` (new): walks a templates dir, parses each, dedupes `ParseContext.reviewItems` by `variableName`, sorts by template count, runs an interactive `[M]apped / [U]nsupported / [S]kip / [Q]uit` loop. Persists decisions after each choice to `url-mappings-pending.json` (crash-safe). Idempotent — already-classified variables skip on re-run. `[M]` prompts for `schemaFieldName` with auto-suggested camelCase default.
- **readline note:** `readline/promises` + callback `rl.question()` both hang after the first prompt when stdin is piped (readline closes on stream end before buffered lines are consumed). Replaced with a line-queue prompter using `rl.on("line")` + queued waiters; returns `null` on EOF so the loop can bail cleanly. Relevant when writing any future interactive CLI in this repo.
- **Two real classifier gaps** surfaced by the aggregator and fixed in `src/parser/url-mapping.ts`:
  1. `CHECKOUT_URL_PATTERNS[0]` + `[1]` now allow optional Liquid filter suffix (`\|[^}]*`), matching `{{ event.URL|default:'' }}` → `checkoutUrl`. Previously only `event.extra.checkout_url` allowed filters.
  2. `UNSUPPORTED_VARIABLES` pattern `fulfillment.tracking_urls` → `tracking_urls?` so Shopify's singular `fulfillment.tracking_url` (single-shipment orders) also blocks.
- **`.gitignore`:** added `url-mappings-pending.json` (ephemeral; engineer folds entries into source).

**Verified**
- merchant-2 (27 templates): `event.URL` drops off review list.
- test-account (388 templates): `fulfillment.tracking_url` drops off; `email` (3 templates) + `order_status_url` (1 template) + `organization.url` (2 templates) remain as genuine unknowns needing a human decision.
- Batch regression across test-account + merchant-2 + merchant-3 (804 templates): 0 failures, 14 total reviewItems, 12 total unsupportedFeatures.

**Files changed**
- `src/migrate/review-variables.ts` (new, 313 lines)
- `src/parser/url-mapping.ts` (+6 -5)
- `.gitignore` (+1)

**Commits on `claude/trusting-carson`** (both pushed)
- `a540e5d` fix(url-mapping): allow Liquid filters in checkout patterns + singular tracking_url
- `d4ded27` feat(migrate): E4 REVIEW list aggregator

**Decisions**
- **No auto-mutation of `url-mapping.ts`** — aggregator writes to `url-mappings-pending.json`; engineer hand-folds entries into source as a follow-up edit. Matches `project_migration_human_input_ux` intent.
- **Pending file at repo root** (not per-migration), gitignored.
- **Surgical commits** — url-mapping.ts fix shipped ahead of the E4 script so parallel sessions (E2 ai-rewrite, E3 fonts) rebase cheaply.

**State at session end**
- Branch: `claude/trusting-carson`, pushed to origin.
- Packages complete: A, B, C, D, F, E1, G, **E4**.
- Parser: 804 templates parsed across 3 corpora, 0 failures.
- Concurrent in-flight (other sessions, uncommitted when I finished): E2 `src/ai-rewrite.ts`, E3 `src/fonts.ts` + export-template wiring.

**Next steps**
1. On a real migration, run `npx tsx src/migrate/review-variables.ts migrations/<account>/templates`, answer M/U prompts, then fold `url-mappings-pending.json` entries into `mapKlaviyoUrlToSchemaField` + `UNSUPPORTED_VARIABLES` as a follow-up PR.
2. Continue E2 (coupon → discount objects + AI rewrite), E3 (font provisioning), E5 (drop-shadow CDN upload).
3. Once E2/E3/E5 land: prod import test, then merge `claude/trusting-carson` to main.

---

## 2026-04-15 — End-to-end import fixes + Package F + E1 variable substitution

**Done**
- **Three import validation bugs fixed:** ObjectId blockIds (nested columns too), schemaType `marketing-email` → `marketing_email`, stale line block missing horizontalPadding/verticalPadding (already fixed in parser, just needed re-export).
- **Image/button placeholder support:** parser now emits empty ImageBlock (no src) and ButtonBlock (no `<a>`, reads `<p>` text) instead of silently dropping. Unblocks column-zipper for placeholder-heavy templates.
- **Stacked-column bail-out:** multi-col rows where each col has >1 block emit flat with a warning instead of zippering into stacked ColumnBlocks (breaks mobile reflow).
- **Package F (parser polish):** renamed `parseHeaderBlock` → `parseHeaderLogoAsImage`, aligned `ProductLayoutType` (`"grid"` → `"columns"`) and `ProductSelectionType` (`"manual"` → `"static"`) with prod enums. Confirmed F2 (line innerPadding), F4 (parsePadding cascade), F5 (MjmlSection padding audit) were already done.
- **E1: Footer variable substitution** via Klaviyo Accounts API. New `src/fetch-account.ts` + `src/transform.ts`. Post-parse pass substitutes `{% unsubscribe %}` → `{{ unsubscribe_link }}`, `{{ organization.name/full_address/url }}` → literal values from Accounts API. `export-template.ts` now async, accepts `KLAVIYO_API_KEY`.
- **merchant-3 extracted:** 388 templates from Klaviyo account `pk_8b9997b013419c24160c5a676da59f2c19` (QuikCamo).
- **Three templates imported end-to-end** into local redoapp team `Mime` (`69dff28302f64f42e6012a4d`): Newsletter #8 (Snack), Newsletter #4 (Story Boxes) x2 (before/after substitution). All pass Redo schema validation.
- **Confirmed deep-dive terminals had no unmerged work** — all on main, clean. TODO-SHARED files are the spec; per-element code changes were never implemented (only shared refactors A-D landed). Terminals safe to close.

**Files created/changed**
- `src/parser/helpers.ts` — ObjectId blockIds
- `src/parser/blocks/header.ts` — rename → parseHeaderLogoAsImage
- `src/parser/blocks/image.ts` — placeholder support
- `src/parser/blocks/button.ts` — placeholder support (no `<a>` fallback)
- `src/parser/blocks/column.ts` — stacked-col bail-out
- `src/parser/blocks/product.ts` — layoutType fix
- `src/parser/blocks/menu.ts` — doc comment update
- `src/parser/index.ts` — header rename ref
- `src/renderer/types.ts` — ProductLayoutType + ProductSelectionType aligned
- `src/export-template.ts` — async, schemaType fix, variable substitution wiring
- `src/fetch-account.ts` (new) — Klaviyo Accounts API client
- `src/transform.ts` (new) — post-parse variable substitution

**Decisions**
- Stacked multi-col → emit flat (not zipper). Mobile reflow breaks with stacked ColumnBlocks.
- Image/button placeholders: emit empty blocks (imageUrl="" / buttonLink="") with warnings, not drop silently.
- Variable substitution lives in transform.ts (post-parse), not in parser. Parser stays deterministic.

**State at session end**
- Parser: 416 templates, 0 failures, 341 warnings
- Packages complete: A, B, C, D, F, E1, G (import executor)
- Branch: `claude/trusting-carson` (3 commits ahead of main)
- Local redoapp running, team Mime has 4+ test templates

**Next steps**
1. E2: Coupon → Redo discount objects + AI text rewrite
2. E3: Font provisioning (Google Fonts → S3 → brand kit)
3. E4: REVIEW list aggregation (interactive variable classification)
4. E5: Drop-shadow CDN upload
5. Merge trusting-carson to main

---

## 2026-04-14 — Integration session: parser split, parallel element work, import path design

**Done**
- **Parser refactor** — split monolithic `src/parser/index.ts` into per-block modules under `src/parser/blocks/<type>.ts` with a thin dispatcher. Enabled parallel per-element deep-dive work across multiple terminals without merge conflicts.
- **Element-isolation viewer** — built `src/element-viewer.ts` that parses templates, filters to one block type, renders each matching block in its own card with JSON toggle. Redo-only (no Klaviyo side-by-side); user compares against the real Klaviyo UI independently.
- **Parallel element deep-dives** (across ~10 terminals): text, image, button, header, menu, line, spacer, socials, column, discount, products, klaviyo-specific (video/preview-quote/drop-shadow). Each terminal wrote its own session log + TODO-SHARED note.
- **Shared-file refactors (Packages A+B+C+D) landed:**
  - `6d76162` — Upstreamed `parsePadding` shorthand override bug fix into `src/parser/style-utils.ts`
  - `9375c37` — Replaced string-prefix warning convention (`REVIEW:`, `UNSUPPORTED:`, `SKIPPED:`) with structured `ParseContext` fields
  - `3bea718` — Hoisted Klaviyo URL classifier into `src/parser/url-mapping.ts` for reuse across button/image/menu/socials
  - `caf90ad` — Aligned `src/renderer/types.ts` with prod Zod schemas (PRODUCTS enum, Size, horizontalPadding/verticalPadding, showCaption, lineHeight/textAlign, removed SocialIconColor.ORIGINAL)
- **TODO-SHARED complete for all 12 elements** — wrote missing files for image, line, header, menu, socials, spacer, column. Previously existed for button, discount, klaviyo-specific, product, text.
- **Consolidated work plan** — `plans/consolidated-todos.md` groups all per-element TODOs into 8 work packages (A–H) with dependencies and parallelization guidance.
- **Import executor scaffolded** — `~/code/redoapp/redo/manage/src/import-klaviyo-templates.ts` (216 lines, uncommitted in redoapp) using `ArgumentParser`, `TeamRepo`, `ProductFilterRepo`, `EmailTemplateRepo`. Handles `_pendingFilter` → `recommendedProductFilterId` swap.
- **Track 4 (polish)** kicked off in parallel terminal.
- **Local redoapp setup** initiated in separate terminal to enable end-to-end testing against a local MongoDB + running redoapp web/api. Setup documentation being written to `docs/SETUP-local-redoapp.md`.
- **Human-input UX design** — walked through all 8 merchant-input touchpoints and locked decisions (see DECISIONS.md + `project_migration_human_input_ux` memory): store ID (CLI flag), discount prefix (default "RE"), discount amount/type (trust+prompt ambiguous), org name/address (Klaviyo API→confirm), image-as-button (strip+flag), fonts (preflight block, no upload), URL variables (interactive M/U/S prompts), static products (Shopify resolver with Column fallback).
- **Research validated:** Klaviyo→Redo template import path (`EmailTemplateRepo.createTemplate` via `redo/manage` script, modeled on `copy-template-to-teams.ts`); brand kit font upload API (scriptable but deferred); Shopify product resolution (live `ShopifyProvider.searchProducts` GraphQL, no cache needed); team vs store ID (same ObjectId, different user-facing term).

**Files created/changed**
- `src/parser/index.ts` — dispatcher-only refactor
- `src/parser/helpers.ts` (new)
- `src/parser/style-utils.ts` — parsePadding shorthand fix
- `src/parser/url-mapping.ts` (new) — hoisted classifier, mapKlaviyoLink, UNSUPPORTED_VARIABLES
- `src/parser/blocks/*.ts` — 12 per-element parsers (new from split)
- `src/parser/blocks/TODO-SHARED-*.md` — per-element follow-up notes (complete set of 12)
- `src/parser/batch-test.ts` (new) — batch regression check
- `src/renderer/types.ts` — aligned with prod Zod
- `src/renderer/blocks/*.tsx` — updated per element deep-dives
- `src/element-viewer.ts` (new)
- `plans/element-deep-dive.md` (new)
- `plans/consolidated-todos.md` (new)
- `~/code/redoapp/redo/manage/src/import-klaviyo-templates.ts` (new, uncommitted) — import executor scaffold
- Memory: `reference_template_import_path`, `reference_team_store_id`, `reference_brand_kit_font_upload`, `project_klaviyo_blocks_not_in_redo`, `project_migration_human_input_ux`

**Decisions (see DECISIONS.md)**
- Static product blocks: Shopify GraphQL handle resolver with Column-of-Images fallback (supersedes earlier "static→Column only" decision)
- AI-minimal pipeline (AI only for inline coupon sentence rewriting; everything else deterministic+prompts)
- Font provisioning: preflight-block, no programmatic upload
- "Store ID" is the user-facing term; internal code uses `team`

**State at session end**
- Parser: 416 templates parsed, 0 failures (warnings 312, down from 322 before refactor)
- Packages complete: A, B, C, D
- Package G: scaffolded in redoapp, not yet tested against live DB
- Package H (polish): running in parallel terminal
- Package E (AI migration pipeline): deferred until G + local redoapp setup complete
- Local redoapp setup: in progress in separate terminal

**Next steps**
1. Let Track 4 (Package H polish) complete and merge
2. Let local redoapp setup complete; verify `bazel build //redo/manage:import-klaviyo-templates` succeeds
3. Seed a test team in local Mongo, run the import script against it with a small migration (e.g. `merchant-2`, 27 templates)
4. Open imported templates in the local Redo builder UI; verify rendering matches the local viewer
5. Iterate on any discrepancies
6. Once local end-to-end works: PR the import executor to redoapp, run against a real test team in prod
7. After prod path is proven: start Package E (migration pipeline — AI + variable substitution + discount objects + font preflight + Shopify resolver for static products)

---

## 2026-04-14 — Products block (interactive-cart) deep-dive

**Done**
- Rewrote `src/parser/blocks/product.ts`: now branches on static vs dynamic. Static (hardcoded URLs, no liquid `feeds.` variables) keeps the existing COLUMN-of-images decomposition with a warning. Dynamic (liquid `{% if feeds.|index:N %}` + `{{ item.* }}`) emits a full `interactive-cart` block with styling extracted from the Klaviyo cell: title font/size/color, image corner radius + size bucket (small ≤100 / medium ≤150 / large from `max-height`), button styling (fill, stroke, corner radius, padding, font) reused for both `lineItemButtons` and `checkoutButton`, columns from cell width %, `numberOfProducts` from cell count, `showPrice/Title/Image/Button` detected from liquid var presence.
- Added a document-level cart-context detector (`CART_CONTEXT_LOOP_RE` scanning the template for `{% for <x> in (event.extra.line_items|items) %}`) memoized per `$` via WeakMap. On hit → `Cart Item` filter default (`products_added_to_cart`, sort price desc, last 90 days, inventory > 0) + `schemaFieldName: "cartContext"`. Otherwise → `Best Sellers` default (random sort via omitted `sortBy`, inventory > 0).
- Parser output carries a non-prod `_pendingFilter: ProductFilterDoc` on the block. The (not-yet-built) executor will POST this to `https://app-server.getredo.com/marketing-rpc/createProductFilter` and swap the returned `productFilterId` into `recommendedProductFilterId` before creating the template.
- New placeholder renderer `src/renderer/blocks/product.tsx` draws an N-cell grid styled per the block's own extracted title/button styling — enough to eyeball the layout in the element viewer. Registered in `src/renderer/index.tsx` componentMap under the `"interactive-cart"` string key (widened map type to `Record<string, …>`).
- Element viewer now filters `product` by `"interactive-cart"` instead of `COLUMN`.
- Verified on `merchant-2/H76ZS6-newsletter-4-story-boxes` (3×3 dynamic grid, Best Sellers pending filter, extracted Helvetica Neue / 14px / #3d3935 / #1155cc button / cornerRadius 5 / sectionPadding {9,18,9,18}) and static fallback still works on `test-account/QPETZp-flow-template` (4 decomposed COLUMNs + warnings).

**Files changed**
- `src/parser/blocks/product.ts` (rewritten)
- `src/parser/blocks/TODO-SHARED-product.md` (new)
- `src/renderer/blocks/product.tsx` (new)
- `src/renderer/index.tsx` (+1 import, +1 map entry, widened map type)
- `src/element-viewer.ts` (typeMap `product` → `"interactive-cart"`)
- Memory: `project_products_block_mapping.md` + MEMORY.md hook

**Decisions**
- Dynamic-only for MVP; static decomposition preserved as warning-generating fallback. See DECISIONS.md entry.
- Filter defaults selected from template HTML alone (Klaviyo Templates API does not expose block-level feed config). Collection-based filters cannot be derived automatically — user must retarget after import.

**Next steps**
1. Executor work (when the redo/manage import script is built per `reference_template_import_path` memory): wrap `createProductFilter` POST → `EmailTemplateRepo.createTemplate` so `_pendingFilter` → `recommendedProductFilterId` swap happens at import time.
2. Confirm unresolved enum values in Redo editor: `imageSize` bucket thresholds, `layoutType` value for multi-col. Currently guessed.
3. When `types.ts` freeze lifts: add `EmailBlockType.PRODUCTS`, `ProductsBlock`, `InlineButton`, `ProductImageSize`, `ProductLayoutType`, `ProductSelectionType` per `TODO-SHARED-product.md`; revert `componentMap` type widening.

---

## 2026-04-14 — Footer block deep-dive (reversed — keep as Text)

**Done**
- Prototyped Footer block end-to-end: `src/parser/blocks/footer.ts` detecting `kl-text` tds containing `{% unsubscribe %}`, `src/renderer/blocks/footer.tsx` as an MJML analogue of prod `EmailFooter`, dispatcher wire-in in `src/parser/index.ts`, `componentMap` wiring in `src/renderer/index.tsx`, and `element-viewer.ts` typeMap entry.
- Confirmed extraction correctness on 3 templates (QZCq6B, YchdbL, Sz3XHM): font/color/padding round-trip fine, inner `<div class="textbody">` overrides picked up (Pontano Sans 12px in 2/3).
- **Reversed the decision after reviewing the rendered footer preview.** Prod FooterBlock forces its own copy/order ("business name / address / Unsubscribe") and destroys Klaviyo's preamble ("No longer want to receive these emails?"). Text block is strictly better: preserves original copy/order verbatim and Redo accepts `{{ unsubscribe_link }}` inline in Text `text` fields (verified via `hasUnsubscribeLink` in `redo/web/.../unsubscribe-link-warning-modal.tsx`).
- Deleted footer parser/renderer/TODO files, reverted all dispatcher/componentMap/typeMap wire-ins.
- Rewrote `TODO-SHARED-text.md` PRIORITY 0 with the new plan: export pipeline substitutes `{% unsubscribe %}` → `<a href="{{ unsubscribe_link }}">unsubscribe</a>`, `{{ organization.name }}` → merchant-provided org name, `{{ organization.full_address }}` → formatted merchant address. Org data sourced from Klaviyo Accounts API, falling back to user prompt — placeholders not acceptable.

**Files changed**
- `src/parser/blocks/TODO-SHARED-text.md` (PRIORITY 0 rewritten)
- Memory: `project_klaviyo_footer_variables.md` + MEMORY.md hook updated to reflect reversal

**Files created then deleted**
- `src/parser/blocks/footer.ts`
- `src/renderer/blocks/footer.tsx`
- `src/parser/blocks/TODO-SHARED-footer.md`

**Decisions**
- Keep footer-style text blocks as TextBlock; do NOT convert to Redo's FooterBlock. See DECISIONS.md entry.

**Next steps**
1. Implement the migration-pipeline text substitution (export-pipeline work, not parser).
2. Pull org name + address: try Klaviyo Accounts API first, fall back to user prompt; store in `manifest.json` under `account` key.
3. Audit for non-`{% unsubscribe %}` patterns (`<kl:unsubscribe-link>`, raw unsubscribe URLs) once full template corpus is available.

---

## 2026-04-14 — Discount block deep-dive

**Done**
- New parser `src/parser/blocks/discount.ts` exports `tryParseDiscountFromText`. Given a `kl-text` TD, it scans the inner HTML for standalone `{% coupon_code 'Name' %}` variables (bounded by `<br/>` or string edges) and splits the text block into `[text before, discount, text after, ...]` — multiple coupons per block handled.
- Inline mid-sentence coupons (e.g. "Just use code {% coupon_code %} at checkout") are intentionally left in the text block for the downstream AI-rewrite pass; they never produce a discount block from the deterministic parser.
- Style cascade is innermost-wins: coupon's immediate `<span style=...>` → inherited open wrappers (via a small tag-stack walk) → outer text-block div. This correctly picks up nested `text-align: center` and wrapping-span `font-family: Alegreya Sans` even when the outer div is `text-align: left` / `Helvetica Neue`.
- Wired into the dispatcher (`src/parser/index.ts`) between the footer check and the normal text parser. When the discount splitter returns a non-null array we push those blocks and skip the text parser for that wrapper.
- Renderer (`src/renderer/blocks/discount.tsx`) now falls back to `"XXXXXX"` when `props.discountCode` is undefined outside the builder env — so parser preview shows a visible placeholder instead of an empty block.
- Verified against RyMuGA-2 (standalone, single `<br/>` bounds) and XvRVJY-2 (standalone, `<br/><br/>` bounds) via `src/element-viewer.ts discount …`. Batch parser green: 415 templates, 0 failures.

**Files changed**
- `src/parser/blocks/discount.ts` (new)
- `src/parser/blocks/TODO-SHARED-discount.md` (new)
- `src/parser/index.ts` (wiring — 1 import + 5-line dispatch)
- `src/renderer/blocks/discount.tsx` (XXXXXX fallback)

**Decisions**
- Split into separate blocks (text + discount + text) rather than a text/discount "hybrid" block. Confirmed by Michael: this matches `project_coupon_to_discount.md` — Redo has no inline coupon primitive, so the discount must be its own block with an associated Redo discount object. The "hybrid" idea was considered but not chosen.
- Klaviyo coupon name (e.g. `"AbandonedCheckout"`) is **not** stored on the parsed DiscountBlock. Per project memory, the downstream flow generates a real Redo discount using a user-provided prefix + AI-inferred amount/type; the Klaviyo name isn't the mapping key.
- Inline coupons are not touched by this terminal — they stay in the text block until the migration's AI-rewrite pass runs.
- Discount blocks are rare in the Klaviyo dataset (only 2 of 415 test templates produce one with standalone coupons), so rare-case correctness was prioritized over coverage.

**Next steps**
1. Implement the migration-layer transforms referenced in `project_coupon_to_discount.md`: (a) discount object creation via Redo API with user-supplied prefix, (b) LLM rewrite of text blocks containing inline coupons.
2. Consider whether `stripStandaloneCoupons` in `blocks/text.ts` can be deleted once the splitter has proven coverage — it's now redundant for standalone cases but harmless as a safety net.

---

## 2026-04-14 — Menu block deep-dive

**Done**
- Fixed `parseMenuFromHeader` across H76ZS6, Hda2jD, K4ca2Z (all 1-item HLBs) plus multi-item examples YjRTWe and X57xAh (3 items each).
- `sectionPadding` now extracted from `hlb-block-settings-content` (was hardcoded `{0,0,0,0}`, causing horizontal misalignment with the sibling logo image). Top zeroed when an `hlb-logo` sibling exists so the split image+menu sections don't double up vertical padding.
- Iterate per `kl-hlb-wrap` wrapper instead of `.find("a")` across the whole wrapper block — pairs each item with its own alignment attribute.
- `alignment` now read from the wrapper's `align` attribute (was hardcoded `CENTER`).
- Font-weight, font-style, and text-decoration extracted from link inline style and encoded into label HTML as `<strong>`/`<em>`/`<u>` wrappers (bold = weight ≥ 600 or "bold"/"bolder").

**Files changed**
- `src/parser/blocks/menu.ts`

**Decisions**
- Font-weight / italic / underline carried via Quill-style inline tags in label HTML since `MenuBlock` schema has no `fontWeight` field.
- Didn't wire up `itemSpacing` / `useCustomSpacing`. Klaviyo's `mso-padding-alt` + `<a>` `padding` describes per-link internal padding (button-styled link), not inter-item gap. Redo's itemSpacing would subtract from section padding and shift the text, degrading alignment. Leave unset.
- Only 2 of 388 test templates have true multi-item menus — most Klaviyo HLBs in this dataset are logo + single CTA link.

**Next steps**
1. Consider Header/Menu consolidation — some HLBs might be better represented as a Header block (logo) + Button block (single CTA) rather than Image + 1-item Menu.
2. If a menu-only HLB (no logo) shows up, verify top padding applies correctly (code path exists but untested).

---

## 2026-04-14 — Socials block deep-dive

**Done**
- Fixed `parseSocialsBlock` across three templates (H76ZS6, KT5Xxh, Kc2UBC).
- Prod-invalid `iconColor: "original"` → now mapped to `SocialIconColor.BLACK`. Prod schema allows only black/white/gray; Klaviyo `/default/` (colorful branded) icons have no perfect match, black is closest.
- Color precedence: prefers specific `/subtle/`, `/solid/`, `/white/` match over `/default/` (→ original) when icons mix, instead of last-wins.
- Alignment now extracted from wrapper's `text-align` style (was hardcoded `CENTER`).
- iconPadding read from first icon's inline-block wrapper (was last icon, which often had empty style).
- Typed output properly with `SocialItem[]`, `SocialPlatform`, `SocialIconColor` — dropped `as any` casts.

**Files changed**
- `src/parser/blocks/socials.ts`

**Decisions**
- Michael confirmed: exact icon color match isn't required, only background/URLs/padding must be correct. Mapping `/default/` → `black` is acceptable lossy conversion.

**Next steps**
1. Similar `"original"` enum cleanup likely needed anywhere else emitting `SocialIconColor.ORIGINAL` for prod output.
2. Renderer subtracts `iconPadding` from section top/bottom — that math is vertical but `iconPadding` is a horizontal gap in Klaviyo. Works visually today but flag if padding ever looks off.

---

## 2026-04-14 — Spacer block fix (parser + renderer)

**Done**
- Fixed `parseSpacerBlock` — was returning null for Klaviyo spacers because it read height from the outer wrapper TD's padding, but Klaviyo puts height in an inner `<div style="height:Npx;line-height:Npx;">` and the bg color on the inner TD (often as `background:` shorthand, not `background-color:`).
- New parser reads the inner div height, sums outer/inner TD padding, and checks both `background` and `background-color` on inner and outer TDs.
- Fixed renderer — MjmlSection defaults to `padding: 20px 0`, so a 9px spacer was rendering as 49px. Added explicit `padding="0"` on section/column/spacer.
- Verified against Kc2UBC (h=9, #ffffff) and QPETZp (h=20, #F8F8F8). Nugivf has no spacers (correct).

**Files changed**
- `src/parser/blocks/spacer.ts`
- `src/renderer/blocks/spacer.tsx`

**Next steps**
1. Audit other renderers (text, image, button, line, etc.) — the MjmlSection default `padding: 20px 0` likely inflates those too if they don't explicitly set section padding.
2. Spacer `sectionPadding` is hardcoded to zeros; swap in `parsePadding(outerStyle)` if a template ever has horizontal padding on the wrapper.

---

## 2026-04-14 — Header block deep-dive + pivot to Image block

**Done**
- Built element-isolation viewer usage into header block workflow (`npx tsx src/element-viewer.ts header <templates>`)
- Fixed initial parser discrepancies in `src/parser/blocks/header.ts`:
  - Logo height heuristic: changed `width/4` → `width/2` (2:1 is typical for logos, not 4:1). Verified against actual image (300x150 PNG).
  - Alignment: now read from `.hlb-logo` TD's `align` attribute instead of hardcoded `CENTER`
- Discovered only 27 distinct `hlb-wrapper` structures across 353 templates using it (98% are logo-only, 6% have logo+menu, 0.6% menu-only)
- Confirmed `gxp-hlb-wrapper` variant (Grid Pixel) is 91% of templates — both prefixes handled by `hasClass()`
- **Pivoted**: header parser no longer produces `HEADER` blocks. Redo's Header component auto-pulls from brand kit (unreliable for migrations). Instead, `parseHeaderBlock` now returns an `ImageBlock` with the logo. Menu items (when present) continue to be extracted separately by `parseMenuFromHeader` → `MenuBlock`.
- Logo centering preserved via calculated inner padding: `(600 - sectionPadding - logoWidth) / 2`, so a 300px Klaviyo logo renders at ~300px in the 600px Redo email.

**Key decisions**
1. **Don't use Redo Header block for migrations** — it auto-pulls logo from brand kit which isn't guaranteed to be set. Use Image block instead for deterministic output.
2. **Logo width preservation via padding math** — ImageBlock is always full-width, so we inject horizontal inner padding to shrink the rendered image to the original Klaviyo logo width.
3. **Dispatcher unchanged** — `parseHeaderBlock` function name kept (misleading now), since `src/parser/index.ts` is a frozen shared file during parallel block work.

**Files changed**
- `src/parser/blocks/header.ts` — now produces `ImageBlock` with calculated padding to preserve logo width

**Non-hlb templates** (~35 templates, cart-discount, checkout-discount, etc.) use plain `kl-image` blocks for logos. Those go through the regular image parser. If we want those treated like headers, needs dispatcher heuristic (first image with "logo" in alt, or similar).

**Next steps**
1. Rename `parseHeaderBlock` → `parseHeaderLogoAsImage` when dispatcher freeze lifts
2. Consider deleting `src/renderer/blocks/header.tsx` — now dead code for Klaviyo migrations
3. Menu block work: address empty menu items with no href (R68eFc has one), add dispatcher heuristic for non-hlb logos

---

## 2026-04-10 to 2026-04-13 — forwarder research + deterministic parser + local viewer

**Done**
- Unblocked redoapp GitHub access (SAML SSO auth for MCHammer-12)
- Cloned redoapp/redo monorepo to ~/code/redoapp (44k files)
- Fully mapped the production email forwarder pipeline (3 stages, 2 LLM calls) → `docs/RESEARCH-forwarder.md`
- Wrote comprehensive explainer doc → `docs/EXPLAINER-pipeline.md`
- Extracted templates from a second Klaviyo account (merchant-2, 27 templates) — confirmed kl-* class pattern is universal
- Discovered 84% of templates use `gxp-kl-*` prefix (Grid Pixel template variant) — parser handles both
- **Built deterministic cheerio parser** (`src/parser/index.ts`) — zero LLM, walks Klaviyo DOM classes:
  - Handles both `kl-*` and `gxp-kl-*` class schemes
  - Extracts all 10 AI block types: header, menu, text, image, button, line, spacer, column, socials, product grids
  - Extracts fonts, colors, padding, URLs directly from inline styles
  - 415 templates tested: 374 clean (90%), 41 with warnings, 0 failures
- **Built local email renderer** (`src/renderer/`) using production Redo block components copied from redoapp:
  - Same React → MJML → HTML pipeline as production
  - Production global styles (p margin reset, quill styles, responsive breakpoints)
  - All 10 block types rendering
- **Built side-by-side comparison viewer** (`src/viewer.ts`):
  - Klaviyo original vs Redo rendered, desktop/mobile toggle, synced scrolling
  - Playwright screenshot support for automated visual comparison
- **Built EmailTemplate exporter** (`src/export-template.ts`):
  - Outputs production-shaped MongoDB document JSON with valid ObjectIds
  - Matches exact field names, enum values, and types from redo/model/src/email-template.ts
- Added second Klaviyo account extraction (merchant-2, pk_75b33...)

**Key decisions**
1. **No LLM needed for Klaviyo migration** — Klaviyo HTML has semantic classes that map directly to Redo block types. Deterministic parser is faster, cheaper, and zero-hallucination.
2. **Copy + strip production renderer** — copied real block components from redoapp with stubs for tracking/UTM/AMP deps, rather than writing approximations.
3. **Scope: Klaviyo first, arbitrary HTML later** — nail the deterministic Klaviyo migration, then separately decide whether to improve the LLM-based forwarder for arbitrary emails.

**Files created/changed**
- `src/parser/index.ts` — Klaviyo HTML → Section[] cheerio parser
- `src/parser/style-utils.ts` — inline CSS parsing utilities
- `src/parser/smoke-test.ts` — parser test + JSON export
- `src/renderer/` — full production-cloned renderer (blocks, stubs, types, utils)
- `src/viewer.ts` — comparison viewer with desktop/mobile toggle
- `src/export-template.ts` — full EmailTemplate JSON exporter
- `src/screenshot.ts`, `src/screenshot-batch.ts` — Playwright visual comparison
- `docs/RESEARCH-forwarder.md` — forwarder pipeline breakdown
- `docs/EXPLAINER-pipeline.md` — full system explainer (Temporal, MJML, block schema, pipeline walkthrough)
- `docs/CONTEXT.md` — updated with redoapp file pointers

**Next steps**
1. Show exported EmailTemplate JSON to eng team — validate structure against a real prod document
2. Hook up to Redo API to import templates directly (POST EmailTemplate)
3. Handle edge cases: discount code detection, Klaviyo template variables → Redo variables
4. Build the flow automation duplicator (the other track — Klaviyo flow topology is already extracted)
5. Polish parser: product grid title/button extraction, line divider visibility, remaining 41 warning templates

## 2026-04-08 — extractor + flow topology breakthrough

**Done**
- Scaffolded mime as a TS/Node ESM project (`src/`, `plans/`, `migrations/`)
- Built shared Klaviyo client `src/klaviyo.ts` (paginate, retry on 429, revision `2025-10-15`)
- Extractors working end-to-end against test-account (key is Quikcamo / QuikCamo, 388 templates):
  - `src/extract-templates.ts` — 388 templates (JSON + HTML)
  - `src/extract-flows.ts` — 49 flows with FULL definition (tree topology, branch conditions, trigger metrics, profile filters)
  - `src/extract-campaigns.ts` (agent-built) — 123 campaigns with inline template HTML
  - `src/extract-images.ts` (agent-built) — 168 images deduped by content hash, cross-referenced to templates
- Built `src/visualize-flow.ts` — generates Mermaid flowchart + standalone HTML viewer from a flow bundle
- Verified V1 -- Abandoned Cart flow renders as a real tree with labeled true/false edges
- Wrote plans: `plans/v1-klaviyo-to-redo.md`, `plans/parallel-build.md`

**Key technical findings**
1. **Klaviyo template drag-drop JSON is NOT exposed.** API returns flattened HTML only. Translator must parse HTML, no block-to-block shortcut.
2. **Campaign templates are hidden.** Campaign-scoped template clones don't appear in `/templates/` listing. Their HTML is only available inline in each campaign bundle.
3. **Flow topology IS exposed — but only via `2025-10-15` revision with `additional-fields[flow]=definition`.** Earlier revisions (including 2024-10-15) return null/error. Legacy v1 API gave branch conditions but no edges. The new definition field returns: triggers, profile_filter, actions array with `links.next`, branches with `links.next_if_true`/`next_if_false`, full email metadata (subject, preview, from_label, template_id).
4. `kyle@quikcamo.com` → 44-action product-aware abandoned cart with 7 branches. Branch conditions key off specific product Name matches ("2-in-1 Leafy Face Mask..." etc.).

**Project pivot mid-session**
Originally framed as "Klaviyo → Redo migrator". Re-scoped to two tracks:
- **Track 1 (current/production):** Improve Redo's existing email forwarder (HTML → Redo JSON parser) with an LLM translator. Uses Klaviyo corpus as eval set. Requires access to redoapp GitHub repo — blocked on SAML/account auth. `MCHammer-12` is not a member of redoapp; need correct work account.
- **Track 2 (future/exploratory):** React HTML drag-drop POC (a separate Claude session was working on this).

**Parallel agent runs**
- Campaigns extractor (Task A) — completed
- Image downloader (Task B) — completed
- Task C (Redo schema) and F (Redo executor login) were supposed to run in separate windows but Task C morphed into a broader architecture analysis (see `plans/parallel-build.md` notes)

**Files changed**
- Created: `src/klaviyo.ts`, `src/extract-templates.ts`, `src/extract-flows.ts`, `src/extract-campaigns.ts`, `src/extract-images.ts`, `src/visualize-flow.ts`, `tsconfig.json`, `package.json`
- Created: `plans/v1-klaviyo-to-redo.md`, `plans/parallel-build.md`
- Created: `docs/CONTEXT.md`, `docs/SESSION-LOG.md`, `docs/DECISIONS.md`, `docs/SETUP.md`

**Next steps**
1. Resolve redoapp GitHub access (wrong account) — blocking Track 1
2. Once repo access works: clone redoapp monorepo (bazel-based), grep for email forwarder code (likely under `redo/merchant/marketing/server/`), read the current parser
3. Build an eval harness: measure current forwarder accuracy on a subset of the 388 Klaviyo templates, then compare with LLM-based parser
4. Optional: chase branch edges that resolve (we have them now) into a block-plan translator for the Klaviyo corpus
5. Task G (normalizer) and Task D (translator POC) are still queued in `plans/parallel-build.md`

## 2026-04-08 — project init
- Created docs/ scaffolding (CONTEXT, SESSION-LOG, DECISIONS, SETUP)
- Purpose: automate manual Redo processes
- Next: identify first workflow to automate

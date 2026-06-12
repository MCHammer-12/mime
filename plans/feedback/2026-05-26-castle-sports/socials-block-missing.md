---
status: done
branch: fix/socials-from-icon-src
pr: https://github.com/MCHammer-12/mime/pull/90
---

# Funnest PE Games email — socials block dropped

## Feedback (verbatim)

Castle Sports `Funnest PE Games opt in` (TSJv4n):

> Great. But there no socials on the email

i.e. the migrated email parsed and rendered with content (`createdTemplateCount: 1`, no warnings) — but the social-media icons row (Facebook / Instagram / etc.) that was in the original Klaviyo email is missing from the Redo output.

## Root cause

Klaviyo has a dedicated `kl-socials` block type. mime has a socials parser ([`src/parser/blocks/socials.ts`](src/parser/blocks/socials.ts)) but it must not be matching Castle's specific socials markup, OR the dispatcher is missing the routing for this specific layout, OR Castle's "socials" are rendered as a custom block (image grid linking out to socials) that the parser sees as something else.

Relevant files:
- [`src/parser/blocks/socials.ts`](src/parser/blocks/socials.ts) — socials block parser
- [`src/renderer/blocks/socials.tsx`](src/renderer/blocks/socials.tsx) — Redo socials render
- [`src/parser/index.ts`](src/parser/index.ts) — dispatcher (kl-socials class routing)

## Proposed change

1. **Pull source HTML** for the Funnest PE Games email (need Klaviyo API key for Castle).
2. **Inspect Castle's socials markup.** What classes / structure does Klaviyo use for this email's socials row? Compare against the patterns mime currently handles. Document the diff in this task file.
3. **Two cases:**
   - **Case A: It's a kl-socials block with markup the parser doesn't recognize.** Extend [`socials.ts`](src/parser/blocks/socials.ts) to handle Castle's variant.
   - **Case B: It's not a kl-socials block — rendered as image-with-link cells in a column block.** Parser correctly sees it as column-of-images. Decision: do we attempt to detect "row of social media icons" heuristically (image src matches `instagram.com`, `facebook.com`, etc.) and convert to socials block? Or leave as-is and let merchant fix in Redo editor? Lean toward leave-as-is + surface as warning, since heuristic detection is error-prone.
4. Smoke test.

## Verify

- Re-import Castle's Funnest PE Games email: socials block appears in the Redo output (if Case A)
- Or: clear preflight warning that surfaces "row of social-media-looking images detected — review in editor" (if Case B + heuristic skipped)
- Smoke test passes
- Other merchants' socials still parse correctly (regression)

## Notes

- Castle Sports also reported "Socials duplicated" — wait, that was Charlie 1 Horse, not Castle. Castle's issue is dropped, not duplicated. Don't conflate.
- If this turns out to be a Klaviyo-extension-app pattern (e.g. a third-party block plugin for socials), the right fix may be to add detection for that specific plugin's markup. Surface to Michael if it's a non-stock Klaviyo block.
- Charlie's socials issue is "socials duplicated" (part of Charlie Task 1 universal-duplication — already merged per git log). Different problem.

## Done

- PR: https://github.com/MCHammer-12/mime/pull/90
- **Confirmed Case A (kl-socials variant the parser couldn't fully
  handle).** Castle's Wnzrvr socials row uses 3 stock Klaviyo icons
  from `…/assets/email/buttons/subtle/{twitter,facebook,instagram}_96.png`,
  laid out as bare `<img>` tags with **no `<a href>` wrappers**. The
  dispatcher correctly routed the wrapper to `parseSocialsBlock` (icon
  src matched the `/assets/email/buttons/` heuristic), but the parser
  then iterated `<a>` tags looking for known social-network URLs, found
  none (no `<a>` at all), and returned null. The wrapper was silently
  dropped.
- Fix shape: added a fallback path in
  [`parseSocialsBlock`](../../../src/parser/blocks/socials.ts). When the
  anchor loop yields zero socialLinks, walk `<img>` tags and infer
  platform from the stock-icon URL filename
  (`/buttons/<variant>/<platform>_<size>.png`). Emit a SocialItem per
  detected platform with `url: ""`. A `ctx.warnings` line surfaces the
  fallback so the operator knows URLs need filling.
- Verification:
  - Castle Wnzrvr now emits 3 SocialItems (twitter / facebook /
    instagram) with empty URLs. Was dropped silently before.
  - batch-test on 416-template corpus: 0 failures. 4 historical
    corpus templates (RexyU6 / RQiCcF / SX2Gn7 / QPETZp — same Klaviyo
    template family judging by name) had previously-silent missing
    socials; they now correctly emit placeholder blocks with the
    fallback warning. Clean/warned shifts -6/+6 reflecting that.
  - Existing socials parsing (with anchors) unchanged — the fallback
    only fires when the anchor loop produced zero links.
- **Not in scope (deferred):**
  - **Filling in URLs.** The fallback emits empty URLs. If a follow-up
    pattern is "merchant socials usually point at $brand.com/$platform",
    that's a per-merchant config that doesn't belong in the parser. The
    merchant fills them in via the Redo editor.

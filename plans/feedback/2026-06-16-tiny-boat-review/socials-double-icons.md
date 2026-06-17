---
status: done
branch: fix/socials-dedup-by-platform
pr: pending
---

# Socials block emits 2 icons per platform (icon anchor + label anchor double-counted)

## Feedback (verbatim)

Tiny Boat (Big 5 template), Michael: "This one has double facebook, youtube, instagram icons. why? its one social block but two icons per social service"

## Root cause — confirmed

Klaviyo's socials markup has **two `<a href>` per platform** with the same URL: the icon anchor (`<a><img …_96.png></a>`) and the text-label anchor (`<a>Facebook</a>`). `parseSocialsBlock` ([socials.ts:66-103](../../../src/parser/blocks/socials.ts)) iterates every `<a href>` and pushes one `SocialItem` each → 6 entries for 3 platforms.

Confirmed from the bundle: source has `2× facebook.com`, `2× youtube.com`, `2× instagram.com`; `redo-output.json` socialLinks = 6 (2 per platform, identical URLs).

## Proposed change

In `parseSocialsBlock`, **dedup by platform** (keep the first occurrence). After detecting `platform` for an anchor, skip if that platform is already in `socialLinks`. Optionally prefer the icon anchor over the label, but first-wins is fine since URLs are identical.

Keep the stock-icon fallback path (PR #90) unchanged — it only fires when zero anchors yielded a platform.

## Verify

- Big 5 re-parsed: socialLinks = 3 (one per platform).
- Regression: a normal one-anchor-per-platform socials block still emits N, not N/2. Add/extend a socials smoke case.

## Done
- Fixed in `parseSocialsBlock` ([socials.ts](../../../src/parser/blocks/socials.ts)): added a `seenPlatforms` Set, dedup first-wins (icon anchor comes first, keeps its color).
- Verified on the actual Big 5 source: socialLinks 6 → **3** (facebook/youtube/instagram, one each).
- batch-test: 416 templates, 0 failures.

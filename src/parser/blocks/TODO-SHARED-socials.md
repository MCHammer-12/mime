# Socials block: session wrap-up & follow-up work

Completed: prod-invalid `iconColor: "original"` mapped to `BLACK` (closest match for Klaviyo's `/default/` colorful icons — Michael confirmed exact match not required), color precedence prefers specific variant over `default` when icons mix, alignment from wrapper `text-align`, iconPadding from first icon's inline-block wrapper, typed output with `SocialItem[]` / `SocialPlatform` / `SocialIconColor`.

---

## PRIORITY 1: Clean up `SocialIconColor.ORIGINAL` references

Local `types.ts` still lists `ORIGINAL` in the `SocialIconColor` enum. Prod schema doesn't. When types freeze lifts, remove `ORIGINAL` from the enum. Audit for any remaining code paths emitting it; map them to a valid value (likely `BLACK`).

---

## PRIORITY 3: iconPadding direction mismatch

Renderer subtracts `iconPadding` from section top/bottom (vertical), but in Klaviyo `padding-right` is a horizontal gap between icons. Works visually on tested templates but the math is semantically wrong.

**Action:** revisit if any template surfaces with visibly wrong icon spacing. Low priority — Redo's renderer may interpret `iconPadding` differently from Klaviyo's.

---

## PRIORITY 4: `useBrandKitSocials` field

Optional field on prod `SocialsBlock`. Not extracted. For migrations, always `false` (we're importing explicit per-template social links, not relying on the merchant's brand kit). Default to `false` when type is added.

---

## Cross-cutting

### URL classification

Social URLs don't go through `mapKlaviyoLink` — same cross-cutting URL classifier issue as buttons/images/menus. When the classifier is hoisted, socials should call it too (though social URLs are almost never Klaviyo `{{ }}` variables, so the impact is minimal).

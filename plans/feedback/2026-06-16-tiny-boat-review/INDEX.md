# Tiny Boat Nation — post-import review — 2026-06-16

Source: `troubleshoot-tiny-boat-nation-2026-06-16T15-58-00-577Z.zip`
Job: `7d9ca9d0-36e8-43c3-ba0b-427f90f7aed4`. **Import succeeded** (the #127 saved-template team fix held — bundle has `redo-output.json` per template). This is Michael reviewing the actual Redo output; all findings diagnosed from bundled `klaviyo-source.html` vs `redo-output.json`.

Templates: VXS62D (Boat Giveaway), TzNyG5 (Big 5 - Ongoing), R3rU5j (AutoBoat).

## Findings → diagnosis → cluster

| # | Finding | Diagnosis (confirmed from bundle) | Routes to |
|---|---------|-----------------------------------|-----------|
| 1 | Double social icons (2 per platform) | Big 5 source has TWO anchors per platform — icon `<a><img></a>` + label `<a>Facebook</a>`, same URL. Parser counts both → `socialLinks` = 6 (2×fb/yt/ig). **Fix: dedup by platform/URL.** | Content (D) — [`socials-double-icons.md`](socials-double-icons.md) |
| 2 | Line breaks wrong both ways | Klaviyo uses `<div>&nbsp;</div>` spacer-divs + trailing empty `<div><strong> </strong></div>` + `<br>`. Parser drops real breaks, invents spurious ones — not reproducing Klaviyo's whitespace model. | Content (D) — text fidelity |
| 3 | Font "not applied" (AutoBoat) | mime DID set `fontFamily: "Helvetica Neue"` on text blocks. But it's a SYSTEM font not in the brand kit → Redo's editor dropdown doesn't show it as *selected*. Recurring. Needs system-font → brand-kit/Google mapping or representation. | Fonts (C) |
| 4 | Bold dropped ("...SMART") | It's an `<h2>` (Klaviyo CSS → bold). mime dropped the heading's implied bold when flattening to a text block. | Content (D) — heading bold |
| 5 | Link color blue→red | Klaviyo links blue (`#15c` ×11); output `linkColor: #0000ee` (blue). Email also has red `rgb(248,1,1)` inline link text ("TOMORROW"). Red is likely that inline span or the contrast guard — **investigate, not yet root-caused.** | Content (D) — investigate |
| 6 | Video block emitted/skipped | mime currently SKIPS `kl-video`. Source has thumbnail `<img>` + `<a href="youtu.be/...">`. **Can emit an Image block w/ thumbnail + video URL as clickthrough.** | Content (D) — [`video-to-image-clickthrough.md`](video-to-image-clickthrough.md) |
| 7 | Static product not selected + button missing | Klaviyo surfaces: name, price ($899.97), image URL, and the **Shopify handle in the product URL** (`/products/autoboat-gps-trolling-motor-anchor-system`). mime resolves by fuzzy NAME → wrong/no pick. **Resolve by handle.** Per-product "Shop now" button (bg `#1155cc`) not carried — Redo product-block button support is a schema question. | Products (E) — extends Charlie 2 |

## Quick wins (clean, low-risk — recommend doing now)
- **#1 socials dedup** — [`socials-double-icons.md`](socials-double-icons.md)
- **#6 video → image clickthrough** — [`video-to-image-clickthrough.md`](video-to-image-clickthrough.md)

## Notes
- The note labels are slightly crossed (double-socials filed under "Boat Giveaway" but VXS62D has no socials — it's the Big 5 template). Bug is real regardless.
- #7 (resolve product by Shopify handle) is a meaningful upgrade to the long-standing `_pendingProducts` name-search approach — the handle is a deterministic selector. Worth folding into the Products cluster as the preferred resolution path.
- Bundle now ships `klaviyo-source.html` + `redo-output.json` per item — this is the richest troubleshoot format yet; diagnosis no longer needs the Klaviyo key.

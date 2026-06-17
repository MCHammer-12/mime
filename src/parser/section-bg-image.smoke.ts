/**
 * Smoke test for the dropped-section-background-image warning.
 *
 *   npx tsx src/parser/section-bg-image.smoke.ts
 *
 * Redo email sections support only a flat `sectionColor`, not a background
 * image (confirmed against redoapp origin/main 2026-06-16). Klaviyo hero
 * backgrounds set via `background:url(...)` are dropped; the parser warns
 * (once per unique URL) so they aren't silently lost. Scoped to Klaviyo
 * media-library images — a raw bg-url match fires on ~52% of templates
 * (Liquid, Outlook VML, migration-tool decoration), so the warning keys on
 * Klaviyo merchant-CDN images (`.../company/<id>/images/...`) only.
 */
import { parseKlaviyoHtml } from "./index.js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
const bgWarnings = (html: string): string[] =>
  parseKlaviyoHtml(html).warnings.filter((w) => /background image not migrated/i.test(w));

// A real Klaviyo media-library image (the merchant-uploaded hero signal).
const KL = "https://d3k81ch9hvuctc.cloudfront.net/company/X5pGs7/images/ded7d827.jpeg";

// shorthand `background:url(<klaviyo image>)` → one warning naming the URL
{
  const w = bgWarnings(`<table><tr><td style="background:#222 url(${KL}) center / cover">hero</td></tr></table>`);
  if (w.length !== 1) fail(`shorthand: expected 1 warning, got ${w.length}`);
  if (!w[0].includes(KL)) fail(`shorthand: warning must name the URL, got: ${w[0]}`);
  console.log("✓ background:url(klaviyo image) shorthand → 1 warning naming the URL");
}

// explicit `background-image:url(<klaviyo image>)` → warning
{
  const w = bgWarnings(`<div style="background-image: url('${KL}');">x</div>`);
  if (w.length !== 1) fail(`background-image: expected 1 warning, got ${w.length}`);
  console.log("✓ background-image:url(klaviyo image) → warning");
}

// same URL on multiple elements (mso fallbacks) → deduped to 1
{
  const w = bgWarnings(
    `<td style="background:url(${KL})">a</td><td style="background:url(${KL})">b</td><div style="background-image:url(${KL})">c</div>`,
  );
  if (w.length !== 1) fail(`dedup: expected 1 warning for a repeated URL, got ${w.length}`);
  console.log("✓ repeated URL → deduped to 1 warning");
}

// non-Klaviyo image host (migration-tool decoration) → NO warning
{
  const w = bgWarnings(`<td style="background:url(https://zaymo-assets.s3.us-west-1.amazonaws.com/frame.png)">x</td>`);
  if (w.length !== 0) fail(`non-klaviyo: expected 0 warnings, got ${w.length}: ${w.join(" | ")}`);
  console.log("✓ non-Klaviyo image host → no warning (avoids tool-decoration noise)");
}

// Liquid-dynamic bg url → NO warning (no fixed image to re-add)
{
  const w = bgWarnings(`<td style="background:url({% if x %}{{ event.img }}{% endif %})">x</td>`);
  if (w.length !== 0) fail(`liquid: expected 0 warnings, got ${w.length}`);
  console.log("✓ Liquid-dynamic bg url → no warning");
}

// flat background-color only → NO warning
{
  const w = bgWarnings(`<td style="background-color:#ff0000;background:#00ff00">solid</td>`);
  if (w.length !== 0) fail(`color-only: expected 0 warnings, got ${w.length}`);
  console.log("✓ background-color only → no warning");
}

console.log("\nAll section-bg-image smoke checks passed.");

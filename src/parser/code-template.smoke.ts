/**
 * Smoke test for code-template.ts P0 fixes:
 *   - Container detection: Zaymo root-container, inline width:600, regex bugfix
 *   - Body-noise skip: <title>/<meta>/<link> + Liquid-only <p>
 *   - mso-hide:all visual skip
 *   - Image width preservation + asymmetric alignment + missing-width reviewItem
 *   - Button link Klaviyo-variable substitution via storeUrl
 *
 *   npx tsx src/parser/code-template.smoke.ts
 */
import { readFileSync, existsSync } from "fs";
import { parseCodeTemplateHtml } from "./code-template.js";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ─── Container detection ──────────────────────────────────────────

console.log("\n[container detection]");

// 1. Zaymo bodyTable preference (deduplicates parallel content)
{
  const html = `
    <body>
      <p>{% if foo %}preheader leak{% endif %}</p>
      <div style="display:table; width:100%;">
        <table><tr><td><p>OUTSIDE COPY</p></td></tr></table>
      </div>
      <div id="bodyTable" class="root-container">
        <table><tr><td><p>INSIDE COPY</p></td></tr></table>
      </div>
    </body>`;
  const r = parseCodeTemplateHtml(html);
  const texts = r.sections
    .filter((s) => s.type === "text")
    .map((s) => (s as any).text)
    .join(" ");
  check(
    "prefers #bodyTable over earlier display:table div",
    texts.includes("INSIDE COPY") && !texts.includes("OUTSIDE COPY"),
    `texts=${texts.slice(0, 100)}`,
  );
}

// 2. Inline width:600px is accepted (in addition to max-width:600)
{
  const html = `
    <body>
      <div style="margin:0 auto; max-width:600px;">
        <p>WIDTH 600 DIV</p>
      </div>
    </body>`;
  const r = parseCodeTemplateHtml(html);
  check(
    "matches div with max-width:600px (regex bugfix)",
    r.warnings.length === 0 && r.sections.length > 0,
    `warnings=${r.warnings.join("|")}, sections=${r.sections.length}`,
  );
}

// 3. Skip kl-section-outlook tables (Outlook-only MSO branch)
{
  const html = `
    <body>
      <table class="kl-section-outlook" width="600"><tr><td><p>OUTLOOK ONLY</p></td></tr></table>
      <table width="600"><tr><td><p>REAL CONTENT</p></td></tr></table>
    </body>`;
  const r = parseCodeTemplateHtml(html);
  const texts = r.sections
    .filter((s) => s.type === "text")
    .map((s) => (s as any).text)
    .join(" ");
  check(
    "skips class=kl-section-outlook",
    texts.includes("REAL CONTENT") && !texts.includes("OUTLOOK ONLY"),
    `texts=${texts.slice(0, 100)}`,
  );
}

// ─── Body-noise filtering ─────────────────────────────────────────

console.log("\n[body noise filtering]");

// 4. <title>, <meta>, <link> in body don't produce sections
{
  const html = `
    <body>
      <title>oops</title>
      <meta charset="utf-8">
      <link rel="stylesheet" href="x.css">
      <p>REAL CONTENT</p>
    </body>`;
  const r = parseCodeTemplateHtml(html);
  const types = r.sections.map((s) => s.type);
  check(
    "skips body-level <title>/<meta>/<link>",
    r.sections.length === 1 && types[0] === "text",
    `types=${types.join(",")}`,
  );
}

// 5. Liquid-only <p> directly under body is treated as preheader leak
{
  const html = `
    <body>
      <p>{% if 'placeholder' in unsubscribe_link %}{{ junk }}{% endif %}</p>
      <p>REAL CONTENT</p>
    </body>`;
  const r = parseCodeTemplateHtml(html);
  const texts = r.sections
    .filter((s) => s.type === "text")
    .map((s) => (s as any).text)
    .join(" ");
  check(
    "skips bare <p> containing only Liquid (preheader leak)",
    texts.includes("REAL CONTENT") && !texts.includes("placeholder"),
    `texts=${texts.slice(0, 100)}`,
  );
}

// 6. mso-hide:all in style → visual skip
{
  const html = `
    <body>
      <div style="mso-hide:all;"><p>HIDDEN</p></div>
      <p>REAL CONTENT</p>
    </body>`;
  const r = parseCodeTemplateHtml(html);
  const texts = r.sections
    .filter((s) => s.type === "text")
    .map((s) => (s as any).text)
    .join(" ");
  check(
    "skips mso-hide:all elements",
    texts.includes("REAL CONTENT") && !texts.includes("HIDDEN"),
    `texts=${texts.slice(0, 100)}`,
  );
}

// ─── Image width preservation ─────────────────────────────────────

console.log("\n[image width]");

// 7. Centered <img width="160"> → symmetric padding
{
  const html = `
    <body>
      <table width="600"><tr><td align="center">
        <img src="logo.png" width="160" height="80">
      </td></tr></table>
    </body>`;
  const r = parseCodeTemplateHtml(html);
  const img = r.sections.find((s) => s.type === "image") as any;
  check(
    "centered image: symmetric padding sized to width",
    !!img && img.sectionPadding.left === 220 && img.sectionPadding.right === 220,
    img ? `padding=${JSON.stringify(img.sectionPadding)}` : "no image emitted",
  );
  check(
    "centered image: horizontalPadding switches to CUSTOM",
    img?.horizontalPadding === "custom",
    img?.horizontalPadding,
  );
  check(
    "centered image: aspectRatio computed from width+height",
    img?.aspectRatio === 2,
    String(img?.aspectRatio),
  );
}

// 8. Left-aligned image dumps slack on the right
{
  const html = `
    <body>
      <table width="600"><tr><td align="left">
        <img src="logo.png" width="160" height="80">
      </td></tr></table>
    </body>`;
  const r = parseCodeTemplateHtml(html);
  const img = r.sections.find((s) => s.type === "image") as any;
  check(
    "left-aligned image: slack on right",
    img?.sectionPadding.left === 0 && img?.sectionPadding.right === 440,
    img ? `padding=${JSON.stringify(img.sectionPadding)}` : "no image emitted",
  );
}

// 9. Right-aligned image dumps slack on the left
{
  const html = `
    <body>
      <table width="600"><tr><td align="right">
        <img src="logo.png" width="160" height="80">
      </td></tr></table>
    </body>`;
  const r = parseCodeTemplateHtml(html);
  const img = r.sections.find((s) => s.type === "image") as any;
  check(
    "right-aligned image: slack on left",
    img?.sectionPadding.left === 440 && img?.sectionPadding.right === 0,
    img ? `padding=${JSON.stringify(img.sectionPadding)}` : "no image emitted",
  );
}

// 10. Missing-width image → reviewItem; full-width preserved
{
  const html = `
    <body>
      <table width="600"><tr><td>
        <img src="hero.png">
      </td></tr></table>
    </body>`;
  const r = parseCodeTemplateHtml(html);
  const img = r.sections.find((s) => s.type === "image") as any;
  check(
    "missing-width image: stays full-width, MEDIUM bucket",
    img?.sectionPadding.left === 0 && img?.sectionPadding.right === 0 && img?.horizontalPadding === "medium",
    img ? `pad=${JSON.stringify(img.sectionPadding)} h=${img.horizontalPadding}` : "no image",
  );
  const hasReview = r.reviewItems.some(
    (ri) => ri.variableName === "image-width-missing" && ri.context === "hero.png",
  );
  check("missing-width image: emits image-width-missing reviewItem", hasReview);
}

// 11. Image wider than container → no padding change
{
  const html = `
    <body>
      <table width="600"><tr><td>
        <img src="hero.png" width="600" height="300">
      </td></tr></table>
    </body>`;
  const r = parseCodeTemplateHtml(html);
  const img = r.sections.find((s) => s.type === "image") as any;
  check(
    "image at full width (600): no padding applied",
    img?.sectionPadding.left === 0 && img?.sectionPadding.right === 0,
    img ? `pad=${JSON.stringify(img.sectionPadding)}` : "no image",
  );
}

// ─── Button link substitution ─────────────────────────────────────

console.log("\n[button link substitution]");

// 12. {{ event.extra.checkout_url }} + storeUrl → <storeUrl>/cart
{
  const html = `
    <body>
      <table width="600"><tr><td>
        <table><tr><td style="background-color:#3383EE;border-radius:4px;">
          <a href="{{ event.extra.checkout_url }}" style="color:#fff;padding:10px 20px;">Buy</a>
        </td></tr></table>
      </td></tr></table>
    </body>`;
  const r = parseCodeTemplateHtml(html, { storeUrl: "https://example.com" });
  const btn = r.sections.find((s) => s.type === "button") as any;
  check(
    "Klaviyo checkout var + storeUrl → static /cart link",
    btn?.buttonLink === "https://example.com/cart",
    btn?.buttonLink,
  );
}

// 13. Static URL passes through unchanged
{
  const html = `
    <body>
      <table width="600"><tr><td>
        <table><tr><td style="background-color:#000;border-radius:4px;">
          <a href="https://example.com/products" style="color:#fff;padding:10px 20px;">Shop</a>
        </td></tr></table>
      </td></tr></table>
    </body>`;
  const r = parseCodeTemplateHtml(html, { storeUrl: "https://example.com" });
  const btn = r.sections.find((s) => s.type === "button") as any;
  check(
    "static URL passes through unchanged",
    btn?.buttonLink === "https://example.com/products",
    btn?.buttonLink,
  );
}

// ─── Castle real-world regression ─────────────────────────────────

console.log("\n[castle RYCBtZ end-to-end]");

{
  const path =
    "migrations/castle-sports/templates/RYCBtZ-2024-08-14-14-32-zaymo-mc-abcart-email1.html";
  if (existsSync(path)) {
    const html = readFileSync(path, "utf-8");
    const r = parseCodeTemplateHtml(html, { storeUrl: "https://castlesports.com" });
    check(
      "Castle RYCBtZ: deduplicated to ~16 sections (was 33 pre-fix)",
      r.sections.length >= 14 && r.sections.length <= 18,
      `sections=${r.sections.length}`,
    );
    check("Castle RYCBtZ: no container warning", r.warnings.length === 0);
    const btn = r.sections.find(
      (s) => s.type === "button" && (s as any).buttonText === "Return to your cart",
    ) as any;
    check(
      "Castle RYCBtZ: cart-recovery button rewrites to /cart",
      btn?.buttonLink === "https://castlesports.com/cart",
      btn?.buttonLink,
    );
    const texts = r.sections.filter((s) => s.type === "text").map((s) => (s as any).text);
    const hasPreheader = texts.some((t: string) => t.includes("placeholder"));
    check("Castle RYCBtZ: no preheader Liquid leak", !hasPreheader);
  } else {
    console.log(`  (skipped — ${path} not on disk)`);
  }
}

// ─── Summary ──────────────────────────────────────────────────────

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) {
  console.log(`\nFailures:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

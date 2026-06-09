/**
 * Smoke test for CODE-template parser P0 fidelity fixes.
 *
 *   npx tsx src/parser/code-template-p0.smoke.ts
 *
 * P0a — Zaymo "root-container" dedup: Zaymo renders a Klaviyo email as TWO
 *   parallel copies directly under <body>. Without recognizing the
 *   root-container the parser deep-walks the body and emits both copies.
 * P0c — button-link Klaviyo-variable substitution: a CODE button linking to
 *   {{ event.extra.checkout_url }} must rewrite to <storeUrl>/cart.
 */
import { parseCodeTemplateHtml } from "./code-template.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// A minimal content section: a single-cell table holding one image. NOT
// 600px-marked — real Zaymo content rows aren't; only the outer container
// is. Distinct images (vs text, which the parser merges across fragments)
// so section counts are meaningful for the dedup assertions.
const imgRow = (n: number) =>
  `<table><tr><td><img src="https://cdn.example.com/img-${n}.png"></td></tr></table>`;
const textRow = (s: string) =>
  `<table><tr><td><div style="font-size:16px">${s}</div></td></tr></table>`;

// ─── P0a: two parallel body copies, one in a Zaymo root-container ──────────
{
  // The generic display:table copy AND the root-container copy each carry
  // the same two images. A naive body deep-walk would emit 4; scoping to
  // root-container emits 2.
  const inner = imgRow(1) + imgRow(2) + textRow("Hey there");
  const html = `<!doctype html><html><body>
    <p>{% if 'placeholder' in unsubscribe_link %}preheader{% endif %}</p>
    <div style="display:table; width:100%;">${inner}</div>
    <div id="bodyTable" class="root-container">${inner}</div>
  </body></html>`;
  const r = parseCodeTemplateHtml(html);
  const imgs = r.sections.filter((s) => s.type === "image");
  assert(
    imgs.length === 2,
    `P0a dedup: expected 2 image sections (one copy), got ${imgs.length} — ${JSON.stringify(r.sections.map((s) => s.type))}`,
  );
  assert(
    !r.warnings.some((w) => w.includes("could not locate 600px container")),
    `P0a: root-container should be found, not deep-walk. warnings=${JSON.stringify(r.warnings)}`,
  );
  // The body-level <p> preheader (outside root-container) must not leak.
  assert(
    !r.sections.some((s) => s.type === "text" && (s as any).text.includes("unsubscribe_link")),
    `P0a: preheader <p> outside root-container leaked`,
  );
  console.log("✓ P0a: root-container dedup (one copy, no preheader leak, no warning)");
}

// ─── P0a: .root-container without id=bodyTable also works ──────────────────
{
  const html = `<!doctype html><html><body>
    <div style="display:table; width:100%;">${imgRow(9)}</div>
    <div class="root-container">${imgRow(9)}</div>
  </body></html>`;
  const r = parseCodeTemplateHtml(html);
  assert(
    r.sections.filter((s) => s.type === "image").length === 1,
    `P0a class-only: expected 1 image section, got ${r.sections.length}`,
  );
  console.log("✓ P0a: bare .root-container (no id) dedupes too");
}

// ─── P0a: table container still wins (no regression) ───────────────────────
{
  // A template with a proper max-width:600 table must keep using table mode
  // even if a root-container also exists — table detection stays first.
  const html = `<!doctype html><html><body>
    <table style="max-width:600px"><tr><td>${textRow("real")}</td></tr></table>
    <div class="root-container">${textRow("dupe")}</div>
  </body></html>`;
  const r = parseCodeTemplateHtml(html);
  assert(
    !r.warnings.some((w) => w.includes("could not locate")),
    `P0a: max-width table should be found first`,
  );
  console.log("✓ P0a: max-width:600 table still detected first (no behavior change)");
}

// ─── P0c: button Klaviyo checkout var → <storeUrl>/cart ────────────────────
{
  const html = `<!doctype html><html><body>
    <div id="bodyTable" class="root-container">
      <table style="width:0px"><tr><td bgcolor="#000000">
        <a href="{{ event.extra.checkout_url }}" style="color:#fff;padding:12px 24px">Return to your cart</a>
      </td></tr></table>
    </div>
  </body></html>`;
  const withStore = parseCodeTemplateHtml(html, { storeUrl: "https://castlesports.com" });
  const btn = withStore.sections.find((s) => s.type === "button") as any;
  assert(!!btn, `P0c: expected a button section, got ${JSON.stringify(withStore.sections.map((s) => s.type))}`);
  assert(
    btn.buttonLink === "https://castlesports.com/cart",
    `P0c: expected /cart rewrite, got ${btn.buttonLink}`,
  );
  assert(withStore.reviewItems.length === 0, `P0c: clean rewrite, no reviewItem`);

  // Without a store URL the variable stays + a reviewItem is pushed.
  const noStore = parseCodeTemplateHtml(html);
  const btn2 = noStore.sections.find((s) => s.type === "button") as any;
  assert(
    btn2.buttonLink === "{{ event.extra.checkout_url }}",
    `P0c no-store: variable preserved, got ${btn2.buttonLink}`,
  );
  assert(noStore.reviewItems.length === 1, `P0c no-store: 1 reviewItem, got ${noStore.reviewItems.length}`);
  console.log("✓ P0c: checkout-URL var → /cart (with store) / preserved + reviewItem (without)");
}

// ─── P0c: static button URL passes through untouched ───────────────────────
{
  const html = `<!doctype html><html><body>
    <div id="bodyTable" class="root-container">
      <table style="width:0px"><tr><td bgcolor="#000000">
        <a href="https://castlesports.com/pages/tax-exemption-form" style="color:#fff;padding:12px 24px">Tax Form</a>
      </td></tr></table>
    </div>
  </body></html>`;
  const r = parseCodeTemplateHtml(html, { storeUrl: "https://castlesports.com" });
  const btn = r.sections.find((s) => s.type === "button") as any;
  assert(
    btn.buttonLink === "https://castlesports.com/pages/tax-exemption-form",
    `P0c static: untouched, got ${btn.buttonLink}`,
  );
  console.log("✓ P0c: static button URL untouched");
}

console.log("code-template-p0.smoke.ts: all assertions passed");

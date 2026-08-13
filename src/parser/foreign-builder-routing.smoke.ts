/**
 * Smoke test for foreign-builder templates (Relay Goods: 6 of 10 emails built
 * in Stripo, pasted into Klaviyo, imported all but empty).
 *
 * Two independent bugs made those emails blank:
 *  1. Routing keyed on "any kl-* class anywhere", so a 68-table Stripo document
 *     containing one pasted Klaviyo product block went to the kl parser — which
 *     walks kl-rows and component-wrappers, found the one block, and dropped
 *     the rest of the email. Now routing keys on how much of the document's
 *     text the kl skeleton actually covers.
 *  2. findContainers() returned only the FIRST 600px container. Stripo splits
 *     every email into three siblings (es-header-body / es-content-body /
 *     es-footer-body), so the CODE parser parsed the logo and stopped.
 *
 * Plus a guard: a near-empty parse now warns instead of shipping silently.
 *
 *   npx tsx src/parser/foreign-builder-routing.smoke.ts
 */
import { exportTemplateFromHtml } from "../export-template.js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const OPTS = { account: null, skipAi: true } as const;

function textOf(sections: any): string {
  let out = "";
  const walk = (o: any): void => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return void o.forEach(walk);
    if (typeof o.text === "string") out += " " + o.text.replace(/<[^>]*>/g, "");
    for (const v of Object.values(o)) walk(v);
  };
  walk(sections);
  return out;
}

// Stripo shape: three sibling 600px tables, with a pasted Klaviyo product block
// inside the content body (which is what used to hijack the routing).
const stripo = `<html><body>
<div class="es-wrapper-color">
  <table class="es-header-body" width="600"><tbody>
    <tr><td><p>HEADER COPY</p></td></tr>
  </tbody></table>
  <table class="es-content-body" width="600"><tbody>
    <tr><td><p>BODY COPY ONE</p></td></tr>
    <tr><td><p>BODY COPY TWO</p></td></tr>
    <tr><td>
      <div class="component-wrapper"><table class="kl-product"><tbody><tr>
        <td class="kl-product-cell-stack">{% for item in feeds.X %}{{ Title }}{% endfor %}</td>
      </tr></tbody></table></div>
    </td></tr>
  </tbody></table>
  <table class="es-footer-body" width="600"><tbody>
    <tr><td><p>FOOTER COPY</p></td></tr>
  </tbody></table>
</div>
</body></html>`;

/** A kl-text cell in the shape the kl parser actually recognizes. */
const klText = (body: string) =>
  `<div class="component-wrapper"><table><tbody><tr><td class="kl-text" style="padding:9px 18px;">` +
  `<div style="text-align:center;line-height:1.3">${body}</div></td></tr></tbody></table></div>`;

// Klaviyo-native shape: must keep using the kl parser.
const native = `<html><body>
<div class="root-container">
  <div class="kl-row"><div class="kl-column">
    ${klText("<h1>NATIVE COPY</h1>")}
  </div></div>
</div>
</body></html>`;

async function main() {
  const s = await exportTemplateFromHtml(
    stripo,
    { name: "stripo", editorType: "USER_DRAGGABLE" },
    OPTS,
  );
  const sText = textOf(s.template.sections ?? []);
  for (const needle of ["HEADER COPY", "BODY COPY ONE", "BODY COPY TWO", "FOOTER COPY"]) {
    if (!sText.includes(needle)) {
      fail(`Stripo template lost "${needle}" — got ${JSON.stringify(sText.trim().slice(0, 200))}`);
    }
  }
  console.log("✓ Stripo template recovers header, body and footer containers");

  const n = await exportTemplateFromHtml(
    native,
    { name: "native", editorType: "SYSTEM_DRAGGABLE" },
    OPTS,
  );
  if (!textOf(n.template.sections ?? []).includes("NATIVE COPY")) {
    fail("Klaviyo-native template no longer parses");
  }
  console.log("✓ Klaviyo-native template still routes to the kl parser");

  // A document that parses to *something* but leaves most of its text behind
  // must warn rather than import silently — that's the failure the six Relay
  // Goods emails slipped through on. Here the kl skeleton wraps one short line
  // and the body copy sits outside it.
  const stranded = `<html><body><div class="root-container"><div class="kl-row"><div class="kl-column">
    ${klText("<h1>hi</h1>")}
  </div></div></div>
  <div>${"Lorem ipsum dolor sit amet consectetur. ".repeat(40)}</div>
  </body></html>`;
  const st = await exportTemplateFromHtml(stranded, { name: "stranded" }, OPTS);
  if ((st.template.sections ?? []).length === 0) {
    fail("stranded fixture parsed to 0 sections — it should test the near-empty path");
  }
  if (!st.warnings.some((w) => /recovered only/.test(w))) {
    fail(`near-empty parse did not warn; warnings: ${JSON.stringify(st.warnings)}`);
  }
  console.log("✓ near-empty parse raises a low-coverage warning");

  // ...and a healthy parse must NOT warn (product-feed Liquid is excluded from
  // the denominator, else every product email would look like a 90% loss).
  const feed = `<html><body><div class="root-container"><div class="kl-row"><div class="kl-column">
    ${klText("<h1>Shop the new drop</h1>")}
    <div class="component-wrapper"><table class="kl-product"><tbody><tr><td class="kl-product-cell-stack">
      ${"{% if feeds.NewProduct|index:0 %}{% with item=feeds.NewProduct|index:0 %}{{ Title }} {{ Price }} {{ Compare_at }}{% endwith %}{% endif %} ".repeat(6)}
    </td></tr></tbody></table></div>
  </div></div></div></body></html>`;
  const f = await exportTemplateFromHtml(feed, { name: "feed" }, OPTS);
  if (f.warnings.some((w) => /recovered only/.test(w))) {
    fail(`product-feed template falsely flagged: ${JSON.stringify(f.warnings)}`);
  }
  console.log("✓ product-feed template is not falsely flagged");

  console.log("\nAll foreign-builder routing smoke checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

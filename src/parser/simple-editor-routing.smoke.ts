/**
 * Smoke test for SIMPLE-editor template routing (Task 9 — Jack Henry, 2 of 8
 * abandoned-cart emails imported blank). `editor_type: SIMPLE` templates are
 * plain <div>/<span> with zero kl-* classes; the default kl parser yields 0
 * sections (blank). They (and any zero-kl HTML) now route to the CODE parser,
 * which extracts text/image/button from arbitrary HTML.
 *
 *   npx tsx src/parser/simple-editor-routing.smoke.ts
 */
import { exportTemplateFromHtml } from "../export-template.js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const OPTS = { account: null, skipAi: true } as const;
const plain = (body: string) => `<html><head></head><body>${body}</body></html>`;
// Mirrors Jack Henry R2rkiC: div/span paragraphs + a {{ organization.url }} CTA.
const SIMPLE_BODY = `
  <div><span>Hi {{ first_name|default:'there' }},</span></div>
  <div>&nbsp;</div>
  <div><span>Noticed you left a few things behind. Still interested?</span></div>
  <div><span><a href="{{ organization.url }}/cart">Return to cart</a></span></div>`;

function sectionsOf(r: any): any[] {
  return r?.template?.sections ?? [];
}
function textOf(secs: any[]): string {
  const flat: any[] = [];
  const w = (b: any[]) => { for (const x of b ?? []) { if (!x) continue; flat.push(x); if (Array.isArray(x.blocks)) w(x.blocks); if (Array.isArray(x.columns)) w(x.columns); } };
  w(secs);
  return flat.filter((b) => b.type === "text").map((b) => String(b.text).replace(/<[^>]+>/g, " ")).join(" ");
}

async function main() {
  // 1. editor_type: SIMPLE → routed to CODE parser → real content, no blank.
  {
    const r = await exportTemplateFromHtml(plain(SIMPLE_BODY), { editorType: "SIMPLE", name: "WC simple" } as any, OPTS);
    const secs = sectionsOf(r);
    if (secs.length < 1) fail(`SIMPLE template produced ${secs.length} sections (expected ≥1 — would import blank)`);
    if (!/Noticed you left/.test(textOf(secs))) fail(`SIMPLE template lost its copy: "${textOf(secs).slice(0, 80)}"`);
    if ((r.warnings ?? []).some((w: string) => /0 sections/.test(w))) fail("SIMPLE template falsely warned blank");
    console.log("✓ editor_type:SIMPLE → routed to CODE parser, ≥1 text section with the copy");
  }

  // 2. zero-kl HTML with NO editorType → also routed (defensive heuristic).
  {
    const r = await exportTemplateFromHtml(plain(SIMPLE_BODY), { name: "no-type" } as any, OPTS);
    if (sectionsOf(r).length < 1) fail("zero-kl, no-editorType template should still route to CODE parser");
    console.log("✓ zero-kl-class + no editorType → routed (≥1 section)");
  }

  // 3. genuinely empty body → 0 sections AND a non-silent blank warning.
  {
    const r = await exportTemplateFromHtml(plain("<div></div>"), { editorType: "SIMPLE", name: "empty" } as any, OPTS);
    if (sectionsOf(r).length !== 0) fail(`empty template should be 0 sections, got ${sectionsOf(r).length}`);
    if (!(r.warnings ?? []).some((w: string) => /0 sections/.test(w))) fail("empty template must emit a blank warning (never silent)");
    console.log("✓ empty body → 0 sections + explicit blank warning (never silent)");
  }

  console.log("\nAll simple-editor-routing smoke checks passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });

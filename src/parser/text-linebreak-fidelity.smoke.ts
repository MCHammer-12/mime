/**
 * Smoke test for text-block line-break fidelity (Tiny Boat "Big 5", VXS62D —
 * Michael 2026-06-16). Two opposite whitespace bugs in one text block:
 *
 *   Spot 1 — Klaviyo wraps `<!--StartFragment-->` / `<!--EndFragment-->`
 *     clipboard markers in empty `<p>`/`<div>`s. The marker renders to nothing
 *     but the empty block renders as a blank line → SPURIOUS breaks after
 *     "…giveaway below:". Fixed in text.ts `stripFragmentNoise`.
 *   Spot 2 — intentional blank-line spacers `<div><strong>&nbsp;</strong></div>`
 *     were stripped by transform.ts `cleanupAfterDrops` (it removed any empty
 *     inline tag incl. `&nbsp;`), collapsing to `<div></div>` which Redo drops
 *     → DROPPED breaks after "Tiny Boat Nation". Fixed by matching only `\s*`,
 *     preserving `&nbsp;`-bearing tags.
 *
 *   npx tsx src/parser/text-linebreak-fidelity.smoke.ts
 */
import { exportTemplateFromHtml } from "../export-template.js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const OPTS = { account: null, skipAi: true } as const;

// Minimal SYSTEM_DRAGGABLE kl text block: kl-row > kl-column > component-wrapper
// > kl-text td > content div. Mirrors VXS62D's two flagged spots plus controls.
const wrap = (inner: string) => `<html><body>
<div class="kl-row"><div class="kl-column">
  <div class="component-wrapper" style="width:100%;">
    <table role="presentation" width="100%"><tbody><tr><td style="padding:0;">
      <table role="presentation" width="100%"><tbody><tr>
        <td align="left" class="kl-text" style="padding:10px;word-break:break-word;">
          <div style="font-family:Arial;font-size:15px;line-height:1.3;color:#333;">${inner}</div>
        </td>
      </tr></tbody></table>
    </td></tr></tbody></table>
  </div>
</div></div>
</body></html>`;

const INNER = `
  <!--StartFragment-->
  <p><span>Check out the giveaway below:</span></p>
  <p><!--EndFragment--></p>
  <div><span style="font-family:Arial"><!--EndFragment--></span></div>
  <div><strong>Tiny Boat Nation</strong></div>
  <div><strong>&nbsp;</strong></div>
  <div><strong>&nbsp;</strong></div>
  <div><strong>&nbsp;</strong></div>
  <span></span>`;

function firstTextHtml(r: any): string {
  const secs = r?.template?.sections ?? [];
  const out: string[] = [];
  const w = (b: any[]) => { for (const x of b ?? []) { if (!x) continue; if (x.type === "text") out.push(x.text); if (Array.isArray(x.blocks)) w(x.blocks); if (Array.isArray(x.columns)) w(x.columns); } };
  w(secs);
  if (out.length === 0) fail("fixture produced no text block (kl parser did not recognize it)");
  return out.join("\n");
}

async function main() {
  const r = await exportTemplateFromHtml(wrap(INNER), { editorType: "SYSTEM_DRAGGABLE", name: "tbn-big5" } as any, OPTS);
  const text = firstTextHtml(r);

  // Spot 1: every fragment marker (and its empty wrapper) is gone → no phantom breaks.
  if (/StartFragment|EndFragment|notionvc/i.test(text)) {
    fail(`fragment markers survived → spurious blank lines:\n${text}`);
  }
  if (/<p[^>]*>\s*<\/p>/i.test(text)) {
    fail(`empty <p> wrapper survived (renders as a blank line):\n${text}`);
  }
  console.log("✓ spot 1: fragment-marker wrappers stripped (no phantom breaks)");

  // Spot 2: the three intentional &nbsp; spacers are preserved (3 blank lines kept).
  const spacers = (text.match(/<strong[^>]*>&nbsp;<\/strong>/gi) ?? []).length;
  if (spacers !== 3) fail(`expected 3 preserved <strong>&nbsp;</strong> spacers, got ${spacers}:\n${text}`);
  console.log("✓ spot 2: 3 intentional &nbsp; blank-line spacers preserved");

  // Real content is untouched.
  if (!/Check out the giveaway below:/.test(text) || !/Tiny Boat Nation/.test(text)) {
    fail(`real copy lost:\n${text}`);
  }
  console.log("✓ real text content preserved verbatim");

  // Regression-safety: cleanupAfterDrops still removes a truly-empty inline tag
  // (its actual job — clearing tags left behind by Klaviyo-tag drops).
  if (/<span[^>]*>\s*<\/span>/i.test(text)) {
    fail(`empty <span></span> drop-leftover should still be removed:\n${text}`);
  }
  console.log("✓ truly-empty inline tags still cleaned (cleanupAfterDrops intact)");

  console.log("\nAll text-linebreak-fidelity smoke checks passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });

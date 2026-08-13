/**
 * Smoke test for the brand-kit font reconciliation helpers.
 *
 *   npx tsx src/fonts.smoke.ts
 *
 * Covers the preflight name-mismatch fix: a Klaviyo template references
 * "Futura" but the operator added it to the brand kit as "Futura PT", so
 * the exact-match check never recognizes it. matchFontToBrandKit fuzzy-
 * matches; rewriteTemplateFontFamilies repoints the template's block-level
 * fontFamily to the brand-kit name.
 */
import {
  fontFamilyKey,
  matchFontToBrandKit,
  normalizeForFontMatch,
  rewriteTemplateFontFamilies,
} from "./fonts.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// ─── normalizeForFontMatch ────────────────────────────────────────────────
assert(normalizeForFontMatch("Futura") === "futura", `Futura → ${normalizeForFontMatch("Futura")}`);
assert(normalizeForFontMatch("Futura PT") === "futura", `Futura PT → ${normalizeForFontMatch("Futura PT")}`);
assert(normalizeForFontMatch("FuturaStd-Medium") === "futura", `FuturaStd-Medium → ${normalizeForFontMatch("FuturaStd-Medium")}`);
assert(normalizeForFontMatch("'Century Gothic'") === "centurygothic", `Century Gothic → ${normalizeForFontMatch("'Century Gothic'")}`);
assert(normalizeForFontMatch("Poppins SemiBold") === "poppins", `Poppins SemiBold → ${normalizeForFontMatch("Poppins SemiBold")}`);
console.log("✓ normalizeForFontMatch strips weight/foundry/case/punct");

// ─── exact match (case-insensitive) ───────────────────────────────────────
{
  const r = matchFontToBrandKit("Futura", ["futura", "Poppins"]);
  assert(r.kind === "match" && r.family === "futura", `exact: ${JSON.stringify(r)}`);
  console.log("✓ exact (case-insensitive) match");
}

// ─── the Futura ≈ Futura PT case (normalized equality) ─────────────────────
{
  const r = matchFontToBrandKit("Futura", ["Futura PT", "Helvetica Neue"]);
  assert(r.kind === "match" && r.family === "Futura PT", `normEq: ${JSON.stringify(r)}`);
  console.log("✓ Futura ≈ Futura PT (normalized equality)");
}

// ─── FuturaStd-Medium added, template says Futura ──────────────────────────
{
  const r = matchFontToBrandKit("Futura", ["FuturaStd-Medium"]);
  assert(r.kind === "match" && r.family === "FuturaStd-Medium", `std: ${JSON.stringify(r)}`);
  console.log("✓ Futura ≈ FuturaStd-Medium");
}

// ─── ambiguous: two brand-kit fonts normalize the same → prompt ────────────
{
  const r = matchFontToBrandKit("Futura", ["Futura PT", "Futura Std"]);
  assert(r.kind === "ambiguous", `ambiguous: ${JSON.stringify(r)}`);
  if (r.kind === "ambiguous") {
    assert(r.candidates.length === 2, `ambiguous candidates: ${JSON.stringify(r.candidates)}`);
  }
  console.log("✓ two same-normalized brand-kit fonts → ambiguous (prompt)");
}

// ─── no match → none ───────────────────────────────────────────────────────
{
  const r = matchFontToBrandKit("Futura", ["Poppins", "Roboto"]);
  assert(r.kind === "none", `none: ${JSON.stringify(r)}`);
  console.log("✓ no candidate → none");
}

// ─── empty brand kit → none ────────────────────────────────────────────────
{
  const r = matchFontToBrandKit("Futura", []);
  assert(r.kind === "none", `empty: ${JSON.stringify(r)}`);
  console.log("✓ empty brand kit → none");
}

// ─── prefix/containment tier ───────────────────────────────────────────────
{
  // "Century Gothic Charlie" (Klaviyo) ⊃ "Century Gothic" (brand kit)
  const r = matchFontToBrandKit("Century Gothic Charlie", ["Century Gothic"]);
  assert(r.kind === "match" && r.family === "Century Gothic", `prefix: ${JSON.stringify(r)}`);
  console.log("✓ containment tier (Century Gothic Charlie ⊃ Century Gothic)");
}

// ─── Tier-3 guard: short generic residual must NOT false-positive ──────────
{
  // "PT Sans" normalizes to "sans" (PT is a foundry noise token). Without
  // the length guard this would containment-match "Sans Forgetica".
  const r = matchFontToBrandKit("PT Sans", ["Sans Forgetica"]);
  assert(r.kind === "none", `short-residual guard: ${JSON.stringify(r)} (must not match Sans Forgetica)`);
  console.log("✓ short generic residual ('sans') does not false-match unrelated font");
}

// ─── Tier-3 still matches a genuine family overlap ─────────────────────────
{
  const r = matchFontToBrandKit("Proxima Nova Extra", ["Proxima Nova"]);
  assert(r.kind === "match" && r.family === "Proxima Nova", `genuine overlap: ${JSON.stringify(r)}`);
  console.log("✓ genuine family overlap still matches (Proxima Nova Extra ⊃ Proxima Nova)");
}

// ─── rewriteTemplateFontFamilies: nested + multiple block types ────────────
{
  const tmpl = {
    sections: [
      { type: "text", fontFamily: "Futura", text: "hi" },
      { type: "menu", fontFamily: "Helvetica Neue" }, // not in mapping → untouched
      {
        type: "column",
        columns: [
          { type: "text", fontFamily: "Futura" },
          null,
          { type: "button", fontFamily: "futura" }, // case-insensitive
        ],
      },
      {
        type: "interactive-cart",
        fontFamily: "Futura",
        checkoutButton: { fontFamily: "Futura" },
        lineItemButtons: { fontFamily: "Helvetica Neue" },
      },
    ],
  };
  const mapping = new Map([["futura", "Futura PT"]]);
  const n = rewriteTemplateFontFamilies(tmpl, mapping);
  assert(n === 5, `expected 5 rewrites, got ${n}`);
  assert((tmpl.sections[0] as any).fontFamily === "Futura PT", "text rewritten");
  assert((tmpl.sections[1] as any).fontFamily === "Helvetica Neue", "menu (unmapped) untouched");
  assert((tmpl.sections[2] as any).columns[0].fontFamily === "Futura PT", "nested column text rewritten");
  assert((tmpl.sections[2] as any).columns[2].fontFamily === "Futura PT", "case-insensitive nested button rewritten");
  assert((tmpl.sections[3] as any).fontFamily === "Futura PT", "products block rewritten");
  assert((tmpl.sections[3] as any).checkoutButton.fontFamily === "Futura PT", "checkoutButton rewritten");
  assert((tmpl.sections[3] as any).lineItemButtons.fontFamily === "Helvetica Neue", "unmapped lineItemButtons untouched");
  console.log("✓ rewriteTemplateFontFamilies repoints all matching blocks (nested + case-insensitive)");
}

// ─── rewrite no-op when mapping empty ──────────────────────────────────────
{
  const tmpl = { sections: [{ type: "text", fontFamily: "Futura" }] };
  const n = rewriteTemplateFontFamilies(tmpl, new Map());
  assert(n === 0 && (tmpl.sections[0] as any).fontFamily === "Futura", "empty mapping → no-op");
  console.log("✓ empty mapping → no rewrite");
}

// ─── fontFamilyKey: base-family dedup key ──────────────────────────────────
{
  // The kit stores server-derived weighted names; we upload the base family.
  assert(fontFamilyKey("Montserrat Thin") === "montserrat", `Montserrat Thin → ${fontFamilyKey("Montserrat Thin")}`);
  assert(fontFamilyKey("Montserrat SemiBold") === "montserrat", `Montserrat SemiBold → ${fontFamilyKey("Montserrat SemiBold")}`);
  assert(fontFamilyKey("Ubuntu Light") === "ubuntu", `Ubuntu Light → ${fontFamilyKey("Ubuntu Light")}`);
  assert(fontFamilyKey("Ubuntu Medium") === "ubuntu", `Ubuntu Medium → ${fontFamilyKey("Ubuntu Medium")}`);
  assert(fontFamilyKey("Roboto") === "roboto", `Roboto → ${fontFamilyKey("Roboto")}`);
  // CamelCase spellings collapse the same way collectFonts collapses them.
  assert(fontFamilyKey("MontserratThin") === "montserrat", `MontserratThin → ${fontFamilyKey("MontserratThin")}`);
  // Distinct families must NOT collide.
  assert(fontFamilyKey("Poppins") !== fontFamilyKey("Roboto"), "distinct families must not collide");
  console.log("✓ fontFamilyKey maps weighted variants onto their base family");
}

// ─── the Brickloot duplicate-upload regression ─────────────────────────────
{
  // Reproduces the real failure: flows import one font pass each, so a base
  // family referenced by N flows ran N upload passes. Pass 1 uploads
  // "Montserrat"; processFontFiles registers it as "Montserrat Thin". Pass 2
  // re-fetches the kit and must recognize that as already-registered.
  //
  // Mirrors the guard in uploadFontsForTemplates (import-rpc.ts).
  const wouldUpload = (planFamily: string, brandKitFamilies: string[]): boolean => {
    const existing = new Set(brandKitFamilies.map(fontFamilyKey));
    return !existing.has(fontFamilyKey(planFamily));
  };

  // Brickloot's kit after pass 1 for each family (names as Redo stored them).
  const kitAfterFirstPass = ["Montserrat Thin", "Roboto", "Ubuntu Light", "Ubuntu", "Ubuntu Medium"];

  assert(!wouldUpload("Montserrat", kitAfterFirstPass), "Montserrat must NOT re-upload (kit holds 'Montserrat Thin')");
  assert(!wouldUpload("Roboto", kitAfterFirstPass), "Roboto must NOT re-upload");
  assert(!wouldUpload("Ubuntu", kitAfterFirstPass), "Ubuntu must NOT re-upload (kit holds weighted variants)");
  // A genuinely new family still uploads.
  assert(wouldUpload("Poppins", kitAfterFirstPass), "an unregistered family must still upload");
  // Empty kit → first pass uploads.
  assert(wouldUpload("Montserrat", []), "empty brand kit → first pass uploads");
  console.log("✓ weighted kit names suppress re-upload (Brickloot duplicate-fonts regression)");
}

// ─── fallback override reconciliation ──────────────────────────────────────
{
  // Same key mismatch silently skipped the fallback override, which is why the
  // duplicated families all read "Fall back to sans-serif" while Roboto (whose
  // registered name matched) correctly read "Fall back to Arial".
  const uploads = [
    { family: "Montserrat", fallback: "Arial" },
    { family: "Ubuntu", fallback: "Verdana" },
  ];
  const findFallback = (registeredName: string): string | undefined =>
    uploads.find((u) => fontFamilyKey(u.family) === fontFamilyKey(registeredName))?.fallback;

  assert(findFallback("Montserrat Thin") === "Arial", `Montserrat Thin fallback → ${findFallback("Montserrat Thin")}`);
  assert(findFallback("Ubuntu Medium") === "Verdana", `Ubuntu Medium fallback → ${findFallback("Ubuntu Medium")}`);
  assert(findFallback("Lora") === undefined, "unrelated family gets no fallback override");
  console.log("✓ fallback override reaches weighted family names");
}

console.log("fonts.smoke.ts: all assertions passed");

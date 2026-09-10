/** Smoke test for the brand-kit font upload path against a stubbed Redo.
 *
 *   npx tsx src/migrate/fonts-upload.smoke.ts
 *
 * Reproduces the Invader Concepts font failure: Google serves "Nunito Sans"
 * as one variable file per style, Redo's processFontFiles names the family
 * from the file's default instance ("Nunito Sans 12pt ExtraLight 12pt"), and
 * every block that asked for "Nunito Sans" fell back to Arial. Also covers
 * the case-only mismatch ("montserrat" vs. the kit's "Montserrat") that the
 * renderer's exact compare never bridged.
 */
import { uploadFontsForTemplates } from "./import-rpc.js";
import { resolveGoogleFont } from "../fonts.js";
import type { FontPlan } from "../fonts.js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function assert(cond: boolean, msg: string): void {
  if (!cond) fail(msg);
}

const BASE = "https://redo.test";
const REGULAR = "https://fonts.gstatic.com/s/nunitosans/v1/variable.woff2";
const ITALIC = "https://fonts.gstatic.com/s/nunitosans/v1/variable-italic.woff2";

const nunitoPlan: FontPlan = {
  hasUnresolved: false,
  entries: [
    {
      family: "Nunito Sans",
      usedBy: ["text"],
      fallback: "Arial",
      resolution: {
        family: "Nunito Sans",
        available: true,
        cssUrl: "https://fonts.googleapis.com/css2?family=Nunito+Sans",
        files: [300, 400, 500, 600, 900].flatMap((weight) => [
          { weight, italic: false, url: REGULAR },
          { weight, italic: true, url: ITALIC },
        ]),
      },
    },
  ],
};

const templates = [
  {
    name: "Welcome",
    _fontPlan: nunitoPlan,
    sections: [
      { type: "text", fontFamily: "Nunito Sans", text: "<p>hi</p>" },
      { type: "button", fontFamily: "montserrat", text: "Shop" },
    ],
  },
  {
    name: "Welcome 2",
    _fontPlan: nunitoPlan,
    sections: [{ type: "text", fontFamily: "montserrat Black", text: "<p>hi</p>" }],
  },
];

const kitBefore = {
  colors: { primary: "#000" },
  customFontFamilies: [
    {
      _id: "kit-montserrat",
      fontFamily: "Montserrat",
      fallbackFont: "Arial",
      styles: [{ _id: "s1", fontName: "Montserrat", fontStyle: "Bold", weight: "700", italic: false, fontFileUrl: "https://data/Montserrat_700.woff2" }],
    },
    { _id: "kit-montserrat-black", fontFamily: "Montserrat Black", fallbackFont: "Arial", styles: [] },
  ],
};

const uploadedNames: string[] = [];
const fontFetches: string[] = [];
let processInput: any = null;
let kitAfter: any = null;

const json = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  headers: { get: () => "application/json" },
  text: async () => JSON.stringify(body),
  arrayBuffer: async () => new ArrayBuffer(4),
});

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url;
  if (url === REGULAR || url === ITALIC) {
    fontFetches.push(url);
    return json(null);
  }
  if (url === `${BASE}/team`) {
    return json({ _id: "membership", team: { _id: "team", settings: { brandKit: kitBefore } } });
  }
  if (url === `${BASE}/team/upload-attachment`) {
    const file = (init.body as FormData).get("attachment") as File;
    uploadedNames.push(file.name);
    return json({ url: `https://data/${file.name}` });
  }
  if (url === `${BASE}/rpc/processFontFiles`) {
    processInput = JSON.parse(init.body).input;
    const byName = (n: string) => `https://data/${n}`;
    return json({
      fontFamilies: [
        {
          _id: "redo-1",
          createdAt: "2026-09-09",
          updatedAt: "2026-09-09",
          fontFamily: "Nunito Sans 12pt ExtraLight 12pt",
          fallbackFont: "sans-serif",
          styles: [
            { _id: "r", fontName: "Nunito Sans 12pt ExtraLight 12pt", fontStyle: "Regular", weight: "200 1000", italic: false, fontFileUrl: byName("NunitoSans-variable.woff2") },
            { _id: "i", fontName: "Nunito Sans 12pt ExtraLight 12pt", fontStyle: "Italic", weight: "200 1000", italic: true, fontFileUrl: byName("NunitoSans-variable-italic.woff2") },
          ],
        },
      ],
    });
  }
  if (url === `${BASE}/rpc/updateBrandKit`) {
    kitAfter = JSON.parse(init.body).input.brandKit;
    return json({ output: {} });
  }
  return fail(`unexpected fetch ${url}`);
}) as unknown as typeof fetch;

const events: any[] = [];
const result = await uploadFontsForTemplates(templates, {
  jwt: "jwt",
  serverBase: BASE,
  onProgress: (e) => events.push(e),
});

// ─── One upload per source file, not per requested weight ───
assert(fontFetches.length === 2, `expected 2 font downloads, got ${fontFetches.length}`);
assert(
  JSON.stringify(uploadedNames) === JSON.stringify(["NunitoSans-variable.woff2", "NunitoSans-variable-italic.woff2"]),
  `upload names: ${JSON.stringify(uploadedNames)}`,
);
assert(result.uploaded === 2, `uploaded=${result.uploaded}`);
assert(result.skipped === 0, `skipped=${result.skipped}`);
assert(processInput.fontUrls.length === 2, "processFontFiles gets both uploads");
console.log("✓ a variable font uploads once per style, named -variable");

// ─── Redo's mangled family is re-keyed under the requested one ───
const newNames = kitAfter.customFontFamilies.map((f: any) => f.fontFamily);
assert(
  JSON.stringify(newNames) ===
    JSON.stringify([
      "Montserrat",
      "Montserrat Black",
      "Nunito Sans Light",
      "Nunito Sans",
      "Nunito Sans Medium",
      "Nunito Sans SemiBold",
      "Nunito Sans Black",
    ]),
  `kit families: ${JSON.stringify(newNames)}`,
);
assert(result.registeredFamilies === 5, `registeredFamilies=${result.registeredFamilies}`);
assert(kitAfter.colors.primary === "#000", "existing kit fields survive the merge");
const byName = Object.fromEntries(kitAfter.customFontFamilies.map((f: any) => [f.fontFamily, f]));
const base = byName["Nunito Sans"];
assert(base._id !== "redo-1", "re-keyed family gets its own _id");
assert(base.fallbackFont === "Arial", `base fallback: ${base.fallbackFont}`);
assert(base.styles.length === 2, "base keeps both styles");
assert(base.styles[0].weight === "200 1000", `base keeps Redo's axis range, got ${base.styles[0].weight}`);
assert(base.styles[0].fontName === "Nunito Sans", "style fontName follows the family");
assert(base.styles[1].italic === true && base.styles[1].fontFileUrl.endsWith("-italic.woff2"), "italic style keeps its file");
const semi = byName["Nunito Sans SemiBold"];
assert(semi.styles.every((s: any) => s.weight === "600"), `weighted family pins its weight: ${JSON.stringify(semi.styles.map((s: any) => s.weight))}`);
assert(new Set(kitAfter.customFontFamilies.flatMap((f: any) => f.styles.map((s: any) => s._id))).size === 11, "every style gets a fresh _id");
console.log("✓ 'Nunito Sans 12pt ExtraLight 12pt' becomes Nunito Sans + weighted families");

// ─── Block names align to the kit's spelling ───
assert(result.aligned === 2, `aligned=${result.aligned}`);
assert(templates[0]!.sections[1]!.fontFamily === "Montserrat", "button 'montserrat' → 'Montserrat'");
assert(templates[1]!.sections[0]!.fontFamily === "Montserrat Black", "'montserrat Black' → 'Montserrat Black'");
assert(templates[0]!.sections[0]!.fontFamily === "Nunito Sans", "an already-exact name is untouched");
const done = events.find((e) => e.kind === "fonts_done");
assert(done?.aligned === 2 && done?.uploaded === 2, `fonts_done event: ${JSON.stringify(done)}`);
console.log("✓ block fontFamily fields are rewritten to the brand kit's exact spelling");

// ─── Second pass: the base family is already in the kit ───
{
  kitBefore.customFontFamilies.push(...kitAfter.customFontFamilies.slice(2));
  uploadedNames.length = 0;
  const again = await uploadFontsForTemplates(
    [{ name: "Again", _fontPlan: nunitoPlan, sections: [{ type: "text", fontFamily: "nunito sans" }] } as any],
    { jwt: "jwt", serverBase: BASE },
  );
  assert(again.uploaded === 0 && again.skipped === 1, `second pass: ${JSON.stringify(again)}`);
  assert(uploadedNames.length === 0, "nothing re-uploaded");
  assert(again.aligned === 1, "alignment still runs when every family is skipped");
  console.log("✓ a registered family is skipped on the next import, block names still aligned");
}

// ─── resolveGoogleFont reports the spelling Google accepted ───
{
  const css = (family: string) =>
    `@font-face { font-family: '${family}'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/x/400.woff2) format('woff2'); }`;
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("family=Montserrat:")) return { ok: true, status: 200, text: async () => css("Montserrat") };
    return { ok: false, status: 400, text: async () => "" };
  }) as unknown as typeof fetch;
  const r = await resolveGoogleFont("montserrat");
  assert(r.available && r.family === "Montserrat", `resolveGoogleFont('montserrat') → ${JSON.stringify(r)}`);
  const exact = await resolveGoogleFont("Montserrat");
  assert(exact.available && exact.family === "Montserrat", "literal spelling passes through");
  console.log("✓ resolveGoogleFont returns the title-cased spelling Google accepted");
}

globalThis.fetch = realFetch;
console.log("ALL PASS");

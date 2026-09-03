/** Smoke test for Klaviyo image re-hosting.
 *
 *   npx tsx src/migrate/rehost-images.smoke.ts
 */

import {
  findKlaviyoImageUrls,
  rewriteImageUrls,
  fileNameFor,
  rehostKlaviyoImages,
  KLAVIYO_ASSET_HOST,
} from "./rehost-images.js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const KL = (n: string) => `https://${KLAVIYO_ASSET_HOST}/company/X5pGs7/images/${n}`;

// Section-level, column-level, and a repeat of the first — the shape the
// Bailey's parse actually produced.
const template = {
  name: "Welcome Email 1",
  sections: [
    { type: "image", imageUrl: KL("logo.png") },
    {
      type: "columns",
      columns: [
        { imageUrl: KL("hero.jpeg") },
        { imageUrl: "https://cdn.shopify.com/keep-me.png" },
      ],
    },
    { type: "image", imageUrl: KL("logo.png") },
  ],
};

// ─── Finding ───

const urls = findKlaviyoImageUrls(template);
if (urls.length !== 2) fail(`expected 2 unique Klaviyo urls, got ${urls.length}: ${urls}`);
if (!urls.includes(KL("logo.png"))) fail("missed the section-level image");
if (!urls.includes(KL("hero.jpeg"))) fail("missed the nested column image");
console.log("✓ finds Klaviyo images at both depths, deduped");

if (findKlaviyoImageUrls({ sections: [{ imageUrl: "https://cdn.shopify.com/x.png" }] }).length !== 0) {
  fail("non-Klaviyo host should not be collected");
}
console.log("✓ leaves non-Klaviyo hosts alone");

// ─── Rewriting ───

const map = new Map([[KL("logo.png"), "https://redo.example/a.png"]]);
const { node, rewritten } = rewriteImageUrls(template, map);
if (rewritten !== 2) fail(`expected 2 fields rewritten (the logo appears twice), got ${rewritten}`);
if (node.sections[0].imageUrl !== "https://redo.example/a.png") fail("section image not rewritten");
if (node.sections[2].imageUrl !== "https://redo.example/a.png") fail("repeat use not rewritten");
if (node.sections[1].columns![0].imageUrl !== KL("hero.jpeg")) {
  fail("unmapped Klaviyo url should be left as-is");
}
if (node.sections[1].columns![1].imageUrl !== "https://cdn.shopify.com/keep-me.png") {
  fail("non-Klaviyo url was touched");
}
if (template.sections[0].imageUrl !== KL("logo.png")) fail("input template was mutated");
console.log("✓ rewrites every use, leaves the input untouched");

// ─── File names ───

if (fileNameFor(KL("ded7d827.jpeg")) !== "ded7d827.jpeg") fail("basename not used");
if (fileNameFor("https://x/company/a/images/abc?v=2") !== "abc.png") fail("extensionless default");
if (fileNameFor("https://x/company/a/images/abc", "image/webp") !== "abc.webp") {
  fail("content-type extension not used");
}
console.log("✓ derives a file name with an extension");

// ─── End to end, with a fake network ───

const realFetch = globalThis.fetch;
let fetches = 0;
globalThis.fetch = (async (url: any) => {
  fetches++;
  if (String(url).includes("hero")) return { ok: false, status: 404 } as any;
  return {
    ok: true,
    status: 200,
    headers: { get: () => "image/png" },
    arrayBuffer: async () => new ArrayBuffer(4),
  } as any;
}) as any;

const uploaded: string[] = [];
const types: Array<string | undefined> = [];
const { template: out, summary } = await rehostKlaviyoImages(
  template,
  async (_bytes, fileName, contentType) => {
    uploaded.push(fileName);
    types.push(contentType);
    return `https://redo.example/${fileName}`;
  },
  "jwt-a",
);
globalThis.fetch = realFetch;

if (summary.rehosted !== 1) fail(`expected 1 upload, got ${summary.rehosted}`);
if (summary.rewritten !== 2) fail(`expected 2 rewrites, got ${summary.rewritten}`);
if (uploaded.length !== 1) fail(`the shared logo should upload once, uploaded ${uploaded.length}`);
if (fetches !== 2) fail(`expected 2 fetches (one per unique url), got ${fetches}`);
if (summary.failed.length !== 1 || !summary.failed[0].url.includes("hero")) {
  fail("the 404 should be reported as a failure");
}
if (out.sections[1].columns![0].imageUrl !== KL("hero.jpeg")) {
  fail("a failed download must keep the original Klaviyo url, not blank it");
}
if (out.sections[0].imageUrl !== "https://redo.example/logo.png") fail("success not rewritten");
if (types[0] !== "image/png") fail(`content type not forwarded, got ${types[0]}`);
console.log("✓ uploads once per asset, keeps the original url when a fetch fails");

console.log("✓ rehost-images smoke tests pass");

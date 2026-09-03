/** Smoke test for store-name resolution (pure picking — no network).
 *
 *   npx tsx src/flow/resolve-store.smoke.ts
 */

import { pickTeam, StoreResolutionError, type Team } from "./resolve-store.js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function expectError(fn: () => unknown, contains: string, label: string) {
  try {
    fn();
  } catch (e) {
    if (e instanceof StoreResolutionError && e.message.includes(contains)) return;
    fail(`${label}: wrong error — ${(e as Error).message}`);
  }
  fail(`${label}: expected an error`);
}

// The live shape: searching "Bailey" returns four stores, one of them exact.
const baileys: Team[] = [
  { _id: "692f63b6ad1cac94751e793a", name: "Bailey's CBD" },
  { _id: "699ca1be87aa01a794d130ee", name: "BAILEY HIKAWA" },
  { _id: "6697f3be9e2ead72ab1c2359", name: "Bailey's Blossoms" },
  { _id: "696901501f81a4fda6e2211a", name: "Bailey Made Tee's & Boutique" },
];

if (pickTeam("Bailey's Blossoms", baileys)._id !== "6697f3be9e2ead72ab1c2359") {
  fail("exact match did not win over three fuzzy ones");
}
console.log("✓ exact name wins over fuzzy matches");

if (pickTeam("bailey's blossoms", baileys)._id !== "6697f3be9e2ead72ab1c2359") fail("case-insensitive match failed");
if (pickTeam("Bailey’s Blossoms", baileys)._id !== "6697f3be9e2ead72ab1c2359") fail("curly apostrophe not normalized");
if (pickTeam("  Bailey's   Blossoms ", baileys)._id !== "6697f3be9e2ead72ab1c2359") fail("whitespace not normalized");
console.log("✓ case, curly apostrophes and whitespace normalized");

// A prefix that matches several and none exactly must stop the run — writing
// into the wrong merchant's account is the one unrecoverable mistake here.
expectError(() => pickTeam("Bailey", baileys), "matches 4 stores", "ambiguous prefix");
console.log("✓ ambiguous name refuses, and names the alternatives");

if (pickTeam("Whatever", [{ _id: "a".repeat(24), name: "Only Store" }])._id !== "a".repeat(24)) {
  fail("single fuzzy result should resolve");
}
console.log("✓ a single result resolves even without an exact match");

expectError(() => pickTeam("Nobody", []), "no Redo store matches", "no results");
expectError(
  () => pickTeam("Twin", [{ _id: "a".repeat(24), name: "Twin" }, { _id: "b".repeat(24), name: "twin" }]),
  "exact name",
  "duplicate exact names",
);
console.log("✓ empty and duplicate-exact results both refuse");

console.log("✓ resolve-store smoke tests pass");

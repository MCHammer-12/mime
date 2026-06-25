/**
 * Smoke test for mapPlatformToRedo (socials.ts).
 *
 * Redo's createEmailTemplate schema accepts only the SocialPlatform enum in
 * redoapp redo/model/src/brand-kit.ts. mime's enum is broader; emitting an
 * unaccepted value (e.g. "x") 400s the ENTIRE template, which the flow importer
 * then saves as a blank email. This locks the alias + drop behaviour.
 *
 *   npx tsx src/parser/blocks/socials-platform-map.smoke.ts
 */
import { mapPlatformToRedo } from "./socials.js";
import { SocialPlatform } from "../../renderer/types.js";

let failures = 0;
function ok(msg: string) {
  console.log(`  ok: ${msg}`);
}
function fail(msg: string) {
  failures++;
  console.log(`  FAIL: ${msg}`);
}
function eq(actual: unknown, expected: unknown, label: string) {
  if (actual === expected) ok(`${label} => ${String(actual)}`);
  else fail(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

// x → twitter (Redo renders the X icon under "twitter"); proven against prod.
eq(mapPlatformToRedo(SocialPlatform.X), SocialPlatform.TWITTER, "x");
eq(mapPlatformToRedo("x"), SocialPlatform.TWITTER, "x (string)");

// Accepted-as-is (in Redo's enum).
for (const p of ["facebook", "instagram", "twitter", "youtube", "tiktok",
  "linkedin", "pinterest", "snapchat", "discord", "reddit"]) {
  eq(mapPlatformToRedo(p), p, `accepted ${p}`);
}

// NOT in Redo's enum → dropped (null) so they never 400 the template.
for (const p of ["threads", "bluesky", "twitch", "telegram", "whatsapp",
  "website", "email"]) {
  eq(mapPlatformToRedo(p), null, `dropped ${p}`);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll socials-platform-map smoke checks passed.");

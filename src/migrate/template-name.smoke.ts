/**
 * Smoke test — template names are rendered to plain text (Jack Henry,
 * 2026-09-10). Redo shows the template name in its list view, so a subject
 * like `Question For {{ customer_first_name |default:'You' }}` used to land
 * as a name with raw Liquid in it. liquidToPlainText renders `default:`
 * values, drops bare tokens and tidies the whitespace left behind. Subjects
 * themselves are untouched (Redo renders them at send time).
 *
 *   npx tsx src/migrate/template-name.smoke.ts
 */
import { liquidToPlainText } from "./import-rpc.js";

let failures = 0;
function fail(msg: string) { console.error(`FAIL: ${msg}`); failures++; }
function ok(msg: string) { console.log(`✓ ${msg}`); }

function check(input: string, expected: string, label: string) {
  const got = liquidToPlainText(input);
  if (got !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
  else ok(`${label} → ${JSON.stringify(got)}`);
}

check(
  "Question For {{ customer_first_name |default:'You'  }}",
  "Question For You",
  "default: literal replaces the token",
);
check(
  '{{ first_name|default:"" }}, Thank You For Your Order',
  "Thank You For Your Order",
  "empty default drops the token and the comma it left behind",
);
check(
  "{{ customer_first_name }}, your cart misses you",
  "your cart misses you",
  "bare token dropped",
);
check(
  "Hey {{ first_name|default:'' }} — {% coupon_code 'JH10' %} inside",
  "Hey — inside",
  "tag dropped, double spaces collapsed",
);
check("Plain subject line", "Plain subject line", "no Liquid → unchanged");
check("{{ first_name }}", "", "Liquid-only subject → empty (caller falls back to 'email')");

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll template-name smoke checks passed.");

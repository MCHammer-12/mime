/**
 * Smoke test for the two link paths that used to skip url-mapping, plus the
 * cache-buster strip. Both surfaced on the Diamond MMA import (2026-08-11):
 * Redo's createEmailTemplate rejects any template still carrying a variable
 * its Marketing trigger can't resolve, so an unmapped link 400s the import.
 *
 *   - Header logo (hlb-logo) href → `<storeUrl>/cart`, not the raw
 *     `{{ event.extra.checkout_url }}`.
 *   - `{{ email }}` appended to an <img src> as a countdown-timer
 *     cache-buster is stripped; the rest of the URL survives.
 *
 *   npx tsx src/parser/link-variable-coverage.smoke.ts
 */
import { parseKlaviyoHtml } from "./index.js";

const STORE = "https://www.example-store.com";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// Mirrors Diamond MMA TNvxCv: the logo bar links to the checkout URL.
const headerHtml = `<html><body>
  <div class="component-wrapper hlb-wrapper">
    <table><tbody><tr>
      <td class="hlb-block-settings-content" style="padding:9px 14px;">
        <table><tbody><tr>
          <td class="hlb-logo">
            <a href="{{ event.extra.checkout_url }}">
              <img alt="Logo" src="https://cdn.example.com/logo.png" width="200" />
            </a>
          </td>
        </tr></tbody></table>
      </td>
    </tr></tbody></table>
  </div>
</body></html>`;

// Mirrors Diamond MMA RG3nJP: a countdownmail timer GIF whose src ends in the
// recipient's email so proxies don't cache one frame.
const timerHtml = `<html><body>
  <div class="component-wrapper">
    <table><tbody><tr>
      <td class="kl-text" style="padding:9px 18px;">
        <div style="text-align:center;line-height:1.3">
          <p><img alt="countdownmail.com" src="http://i.countdownmail.com/odzr1.gif?id=abc123{{ email }}" width="600" /></p>
        </div>
      </td>
    </tr></tbody></table>
  </div>
</body></html>`;

function strings(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  for (const v of Object.values(node as Record<string, unknown>)) strings(v, out);
  return out;
}

const header = parseKlaviyoHtml(headerHtml, { storeUrl: STORE });
const logo = header.sections.find((s: any) => s.clickthroughUrl) as any;
if (!logo) fail("header logo emitted no clickthroughUrl");
if (logo.clickthroughUrl !== `${STORE}/cart`) {
  fail(`header logo link should be ${STORE}/cart, got ${logo.clickthroughUrl}`);
}
console.log(`✓ header logo checkout variable → ${logo.clickthroughUrl}`);

const timer = parseKlaviyoHtml(timerHtml, { storeUrl: STORE });
const timerText = strings(timer.sections).find((s) => s.includes("countdownmail"));
if (!timerText) fail("timer image did not survive the text parse");
if (/\{\{|\{%/.test(timerText)) {
  fail(`timer src kept a template variable: ${timerText.slice(0, 160)}`);
}
if (!timerText.includes("odzr1.gif?id=abc123")) {
  fail(`timer src lost its real URL: ${timerText.slice(0, 160)}`);
}
if (!timer.warnings.some((w) => /Removed template variable/.test(w))) {
  fail("stripping the cache-buster should warn");
}
console.log("✓ {{ email }} cache-buster stripped, timer URL intact, warned");

console.log("\nAll link-variable-coverage smoke checks passed.");

import { chromium } from "playwright";

const file = process.argv[2] || ".viewer/compare.html";
const out = process.argv[3] || "pics/comparison-screenshot.png";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(`file://${process.cwd()}/${file}`);
await page.waitForTimeout(2000);
await page.screenshot({ path: out, fullPage: false });
await browser.close();
console.log(`Screenshot saved to ${out}`);

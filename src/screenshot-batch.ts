import { chromium } from "playwright";
import { execSync } from "child_process";

const templates = [
  {
    label: "campaign",
    html: "migrations/test-account/templates/StiyUD-grid-pixel-campaign-nov-29-2025-last-shot-save-30-off-plus-f.html",
    json: "migrations/test-account/templates/StiyUD-grid-pixel-campaign-nov-29-2025-last-shot-save-30-off-plus-f.sections.json",
  },
  {
    label: "welcome",
    html: "migrations/test-account/templates/Thuze8-grid-pixel-welcome-1-new-v8-modern.html",
    json: "migrations/test-account/templates/Thuze8-grid-pixel-welcome-1-new-v8-modern.sections.json",
  },
  {
    label: "newsletter",
    html: "migrations/merchant-2/templates/Sb3eYt-newsletter-8-snack-w-recommendations.html",
    json: "migrations/merchant-2/templates/Sb3eYt-newsletter-8-snack-w-recommendations.sections.json",
  },
];

const browser = await chromium.launch();

for (const t of templates) {
  // Generate comparison HTML
  execSync(`npx tsx src/viewer.ts --compare ${t.html} ${t.json}`, {
    stdio: "pipe",
  });

  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(
    `file://${process.cwd()}/.viewer/compare.html`,
  );
  await page.waitForTimeout(2000);
  await page.screenshot({
    path: `pics/compare-${t.label}.png`,
    fullPage: false,
  });
  await page.close();
  console.log(`Saved pics/compare-${t.label}.png`);
}

await browser.close();

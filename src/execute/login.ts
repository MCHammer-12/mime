import { chromium, type BrowserContext } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const AUTH_PATH = ".auth/redo.json";
const SCREENSHOT = "migrations/debug/executor-login.png";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

async function ensureDir(p: string) {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

async function main() {
  const url = arg("url", "https://app.getredo.com")!;
  const loginUrl = arg("login-url", "https://admin.getredo.com")!;
  const store = arg("store");
  const haveAuth = existsSync(AUTH_PATH);

  await ensureDir(AUTH_PATH);
  await ensureDir(SCREENSHOT);

  const browser = await chromium.launch({ headless: false });
  const context: BrowserContext = haveAuth
    ? await browser.newContext({ storageState: AUTH_PATH })
    : await browser.newContext();

  const page = await context.newPage();
  await page.goto(haveAuth ? url : loginUrl, { waitUntil: "domcontentloaded" });

  if (!haveAuth) {
    const sentinel = ".auth/ready";
    console.log(`Log in at ${loginUrl}, then click through to ${url} so both domains' cookies are captured. When done, create sentinel: touch ${sentinel}`);
    while (!existsSync(sentinel)) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    await context.storageState({ path: AUTH_PATH });
    console.log(`Saved auth state to ${AUTH_PATH}`);
  } else {
    console.log("Reusing saved auth state.");
  }

  if (haveAuth && store) {
    const target = `${url.replace(/\/$/, "")}/stores/${store}/marketing/email-sms/templates`;
    await page.goto(target, { waitUntil: "domcontentloaded" });
    console.log(`Navigated to ${target}`);
    await page.waitForLoadState("networkidle").catch(() => {});
  } else {
    console.log(`Current URL: ${page.url()}`);
  }

  await page.waitForTimeout(2500);
  await page.screenshot({ path: SCREENSHOT, fullPage: true });
  console.log(`Screenshot saved to ${SCREENSHOT}`);

  await browser.close();
  console.log("Task F login skeleton: done.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

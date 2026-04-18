/**
 * Interactive end-to-end Klaviyo → Redo migration.
 *
 * Fetches your Klaviyo template list, lets you select which to migrate,
 * exports them through the mime pipeline, then hands off to the Redo
 * import manage script.
 *
 * Usage:
 *   npx tsx src/migrate/migrate.ts
 *
 * Env vars (all optional — you'll be prompted if missing):
 *   KLAVIYO_API_KEY
 *   ANTHROPIC_API_KEY  (or AI_INTEGRATIONS_ANTHROPIC_API_KEY)
 *   REDOAPP_DIR        (defaults to ~/code/redoapp)
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fetchAccount } from "../fetch-account.js";
import { exportTemplate } from "../export-template.js";
import { klaviyo, paginate, slug } from "../klaviyo.js";

const MIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../");
const DEFAULT_REDOAPP_DIR = join(homedir(), "code/redoapp");

// ─── Helpers ───────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
}

function askSecret(question: string): Promise<string> {
  process.stdout.write(question);
  return new Promise((resolve) => {
    let value = "";
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", function handler(ch: string) {
      if (ch === "\r" || ch === "\n") {
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdin.removeListener("data", handler);
        process.stdout.write("\n");
        resolve(value);
      } else if (ch === "\u0003") {
        process.exit();
      } else if (ch === "\u007f") {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    });
  });
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("\nRedo Klaviyo Migration");
  console.log("======================\n");

  const storeId = await ask("Store ID: ");
  if (!storeId) { console.error("Store ID required"); process.exit(1); }

  const klaviyoKey = process.env.KLAVIYO_API_KEY
    || await askSecret("Klaviyo API key: ");
  if (!klaviyoKey) { console.error("Klaviyo API key required"); process.exit(1); }

  const merchantSlug = await ask("Merchant slug (directory name, e.g. acme-brand): ");
  if (!merchantSlug) { console.error("Merchant slug required"); process.exit(1); }

  const envAnthropicKey =
    process.env.ANTHROPIC_API_KEY ||
    process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  const anthropicKey = envAnthropicKey || await ask("Anthropic API key (enter to skip AI rewrites): ") || undefined;
  if (anthropicKey && !envAnthropicKey) {
    process.env.ANTHROPIC_API_KEY = anthropicKey;
  }

  const redoappDir = process.env.REDOAPP_DIR || DEFAULT_REDOAPP_DIR;

  // ── 1. List templates (sparse fields — no HTML yet) ──────────────────────
  console.log("\nFetching templates from Klaviyo...");
  type TemplateMeta = { id: string; attributes: { name: string; editor_type: string; updated: string } };
  const all = await paginate<TemplateMeta>(
    "/templates/?fields[template]=name,editor_type,updated&sort=-updated",
    klaviyoKey,
  );

  const templates = all.filter((t) => t.attributes.editor_type !== "KLAVIYO");
  const skipped = all.length - templates.length;
  console.log(
    `Found ${templates.length} template(s)` +
    (skipped > 0 ? ` (${skipped} Klaviyo built-in(s) hidden)` : "") +
    ".\n",
  );

  if (templates.length === 0) {
    console.log("Nothing to migrate.");
    rl.close();
    return;
  }

  // ── 2. Display list ───────────────────────────────────────────────────────
  templates.forEach((t, i) => {
    const date = t.attributes.updated?.split("T")[0] ?? "";
    const tag = t.attributes.editor_type === "CODE" ? " [code]" : "";
    console.log(`  ${String(i + 1).padStart(3)}. ${t.attributes.name}${tag}  ${date}`);
  });

  // ── 3. Select ─────────────────────────────────────────────────────────────
  const raw = await ask('\nSelect templates (e.g. "1,3,5" or "all"): ');
  let selected: TemplateMeta[];
  if (raw.toLowerCase() === "all") {
    selected = templates;
  } else {
    const indices = raw
      .split(",")
      .map((s) => parseInt(s.trim(), 10) - 1)
      .filter((i) => i >= 0 && i < templates.length);
    selected = indices.map((i) => templates[i]!);
  }

  if (selected.length === 0) {
    console.log("Nothing selected.");
    rl.close();
    return;
  }
  console.log(`\nSelected ${selected.length} template(s).`);

  // ── 4. Fetch Klaviyo account for variable substitution ────────────────────
  let account = null;
  try {
    account = await fetchAccount(klaviyoKey);
    console.log(`Account: ${account.organizationName}`);
  } catch (e: any) {
    console.warn(`Could not fetch Klaviyo account (${e.message}). Variable substitution will be skipped.`);
  }

  const skipAi = !anthropicKey;
  if (skipAi) console.log("AI rewrites: disabled (no Anthropic key).");

  // ── 5. Download HTML + export each selected template ─────────────────────
  const templatesDir = join(MIME_ROOT, "migrations", merchantSlug, "templates");
  mkdirSync(templatesDir, { recursive: true });

  console.log(`\nExporting to migrations/${merchantSlug}/templates/ ...\n`);

  let successCount = 0;
  let failCount = 0;
  const failures: { name: string; error: string }[] = [];

  for (const t of selected) {
    const name = t.attributes.name;
    const base = `${t.id}-${slug(name, t.id)}`;
    const htmlPath = join(templatesDir, `${base}.html`);
    const jsonPath = join(templatesDir, `${base}.json`);

    process.stdout.write(`  ${name} … `);

    try {
      // Download full template data (includes HTML)
      const full = await klaviyo(`/templates/${t.id}/`, klaviyoKey);
      const html: string = full.data?.attributes?.html ?? "";
      if (!html) throw new Error("template has no HTML (editor_type may not be supported)");

      writeFileSync(htmlPath, html, "utf8");
      writeFileSync(jsonPath, JSON.stringify(full.data, null, 2), "utf8");

      // Run through mime export pipeline
      const result = await exportTemplate(htmlPath, { account, skipAi });

      const flags: string[] = [];
      if (result.warnings.length > 0) flags.push(`${result.warnings.length}w`);
      if (result.unsupportedFeatures.length > 0) flags.push(`${result.unsupportedFeatures.length}u`);
      if (result.reviewItems.length > 0) flags.push(`${result.reviewItems.length}r`);
      if (result.aiRewrites > 0) flags.push(`${result.aiRewrites}ai`);
      if (result.fontPlan.hasUnresolved) flags.push("font!");

      console.log(`ok (${result.sectionCount}s)${flags.length > 0 ? " [" + flags.join(" ") + "]" : ""}`);
      successCount++;
    } catch (e: any) {
      const msg = e.message || String(e);
      console.log(`FAILED: ${msg}`);
      failures.push({ name, error: msg });
      failCount++;
    }
  }

  console.log(`\nExport: ${successCount} ok, ${failCount} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  }

  if (successCount === 0) {
    rl.close();
    return;
  }

  // ── 6. Import into Redo ───────────────────────────────────────────────────
  const importArgs = [
    "run", "//redo/manage:import-klaviyo-templates", "--",
    "--team", storeId,
    "--account", merchantSlug,
    "--mime-dir", MIME_ROOT,
  ];
  const importCmdStr = `cd ${redoappDir} && bazel ${importArgs.join(" ")}`;

  const doImport = await ask(
    `\nImport ${successCount} template(s) into store ${storeId}? (y/n): `,
  );
  rl.close();

  if (doImport !== "y") {
    console.log(`\nSkipping import. Run it yourself:\n  ${importCmdStr}`);
    return;
  }

  if (!existsSync(redoappDir)) {
    console.error(`\nCannot find redoapp at ${redoappDir}.`);
    console.error(`Set REDOAPP_DIR or run manually:\n  ${importCmdStr}`);
    process.exit(1);
  }

  console.log("\nRunning import...\n");

  // Auto-confirm the manage script's own "y/n" prompt by piping "y\n" to stdin
  const proc = spawnSync("bazel", importArgs, {
    cwd: redoappDir,
    stdio: ["pipe", "inherit", "inherit"],
    input: "y\n",
  });

  if (proc.status !== 0) {
    console.error(`\nImport exited with code ${proc.status}.`);
    console.error(`Run manually:\n  ${importCmdStr}`);
    process.exit(1);
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  rl.close();
  process.exit(1);
});

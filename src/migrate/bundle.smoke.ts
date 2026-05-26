/**
 * Quick smoke-test for the troubleshoot bundle. Builds a synthetic JobState
 * pointing at a real template in the migrations/ corpus, runs streamBundle
 * to a tmp file, and prints the zip's entry list so we can eyeball that
 * everything we expect is in there.
 *
 *   npx tsx src/migrate/bundle.smoke.ts <merchant-slug> <template-id>
 *   npx tsx src/migrate/bundle.smoke.ts --event-fallback   # event-only test
 *
 * Example:
 *   npx tsx src/migrate/bundle.smoke.ts test-account Nugivf
 */
import { createWriteStream, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ServerResponse } from "node:http";
import { streamBundle, type BundleItemRequest } from "./bundle.js";
import type { JobEvent, JobState } from "./jobs.js";

async function eventFallbackMode() {
  // Replit-style scenario: migrations/<slug>/{templates,flows} dirs are
  // empty, but the events captured Klaviyo source in their payloads.
  // Bundle should land both klaviyo-source.html and klaviyo-flow.json from
  // the payloads. Uses a sentinel slug guaranteed to miss the disk lookup.
  const slug = "__nonexistent_smoke_slug__";
  const templateId = "tmpl-1";
  const flowId = "flow-1";
  const events: JobEvent[] = [
    {
      seq: 1,
      at: new Date().toISOString(),
      kind: "exported",
      severity: "success",
      payload: {
        id: templateId,
        name: "Event-fallback template",
        sectionCount: 3,
        warningList: [],
        klaviyoHtml: "<html><body>fallback source</body></html>",
        klaviyoMeta: { id: templateId, attributes: { name: "Fallback" } },
      },
    },
    {
      seq: 2,
      at: new Date().toISOString(),
      kind: "flow_imported",
      severity: "success",
      payload: {
        id: flowId,
        name: "Event-fallback flow",
        createdTemplateCount: 1,
        blankTemplateCount: 0,
        warningList: [],
        klaviyoFlow: { data: { id: flowId, attributes: { name: "Fallback flow" } } },
      },
    },
  ];
  const job: JobState = {
    id: "00000000-0000-0000-0000-000000000001",
    storeId: "store-x",
    storeName: "Event Fallback Store",
    merchantSlug: slug,
    status: "completed",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    templateIds: [templateId],
    flowIds: [flowId],
    events,
    answers: {},
    notes: {},
  };
  const items: BundleItemRequest[] = [
    { id: templateId, type: "template" },
    { id: flowId, type: "flow" },
  ];
  const outPath = join(tmpdir(), `bundle-eventfallback.zip`);
  const file = createWriteStream(outPath);
  await streamBundle(job, items, file as unknown as ServerResponse);
  await new Promise<void>((resolve) => file.end(() => resolve()));

  // Assert: klaviyo-source.html, klaviyo-meta.json, klaviyo-flow.json all present
  const r = spawnSync("unzip", ["-l", outPath], { encoding: "utf8" });
  const out = r.stdout;
  const need = [
    `template-${templateId}/klaviyo-source.html`,
    `template-${templateId}/klaviyo-meta.json`,
    `flow-${flowId}/klaviyo-flow.json`,
  ];
  for (const entry of need) {
    if (!out.includes(entry)) {
      console.error(`FAIL: expected ${entry} in bundle\n${out}`);
      process.exit(1);
    }
  }
  console.log(`✓ event-payload fallback: klaviyo source served from event payload (${statSync(outPath).size} bytes)`);
}

async function main() {
  if (process.argv[2] === "--event-fallback") {
    await eventFallbackMode();
    return;
  }
  const slug = process.argv[2];
  const id = process.argv[3];
  if (!slug || !id) {
    console.error("usage: bundle.smoke.ts <merchant-slug> <template-id>");
    console.error("       bundle.smoke.ts --event-fallback");
    process.exit(1);
  }

  const exportedEvent: JobEvent = {
    seq: 1,
    at: new Date().toISOString(),
    kind: "exported",
    severity: "success",
    payload: {
      id,
      name: `Smoke test for ${id}`,
      sectionCount: 10,
      warningList: ["fake warning for smoke test"],
      substitutions: ["fake sub for smoke test"],
      unsupportedList: [],
      reviewItemList: [],
      skippedList: [],
      fontPlanEntries: [],
    },
  };

  const job: JobState = {
    id: "00000000-0000-0000-0000-000000000000",
    storeId: "store-x",
    storeName: "Smoke Test Store",
    merchantSlug: slug,
    status: "completed",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    templateIds: [id],
    flowIds: [],
    events: [exportedEvent],
    answers: {},
    notes: {
      [id]: "the footer is missing padding and the unsubscribe link doesn't work",
    },
  };

  const items: BundleItemRequest[] = [{ id, type: "template" }];
  const outPath = join(tmpdir(), `bundle-${id}.zip`);

  // Use a writable file stream as a stand-in for ServerResponse.
  const file = createWriteStream(outPath);
  // streamBundle calls writeHead on real responses; for the file we don't
  // care. Adapt by adding a no-op writeHead that matches the signature
  // streamBundle uses. (It also calls res.destroy() on archive errors —
  // forward those to the file stream.)
  const fakeRes = file as unknown as ServerResponse;
  await streamBundle(job, items, fakeRes);
  await new Promise<void>((resolve) => file.end(() => resolve()));

  const st = statSync(outPath);
  console.log(`✓ wrote ${outPath} (${st.size} bytes)`);
  console.log("entries:");
  const r = spawnSync("unzip", ["-l", outPath], { encoding: "utf8" });
  process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

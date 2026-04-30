/**
 * Quick smoke-test for the troubleshoot bundle. Builds a synthetic JobState
 * pointing at a real template in the migrations/ corpus, runs streamBundle
 * to a tmp file, and prints the zip's entry list so we can eyeball that
 * everything we expect is in there.
 *
 *   npx tsx src/migrate/bundle.smoke.ts <merchant-slug> <template-id>
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

async function main() {
  const slug = process.argv[2];
  const id = process.argv[3];
  if (!slug || !id) {
    console.error("usage: bundle.smoke.ts <merchant-slug> <template-id>");
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

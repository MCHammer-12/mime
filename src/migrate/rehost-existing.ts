/** Re-host Klaviyo images on templates that were already imported.
 *
 * The import path re-hosts as it goes (see rehost-images.ts), but every store
 * migrated before that landed still has emails pointing at Klaviyo's CDN. Those
 * break when the merchant stops paying Klaviyo, months after anyone is watching.
 * This walks a store's existing templates and fixes them in place.
 *
 *   REDO_JWT=… npx tsx src/migrate/rehost-existing.ts
 *   REDO_JWT=… NAME_FILTER="BB |" DRY_RUN=1 npx tsx src/migrate/rehost-existing.ts
 *   REDO_JWT=… TEMPLATE_IDS=<id>,<id> npx tsx src/migrate/rehost-existing.ts
 */

import {
  postMarketingRpc,
  uploadAttachment,
  type ImportOptions,
} from "./import-rpc.js";
import { findKlaviyoImageUrls, rehostKlaviyoImages } from "./rehost-images.js";

/** Fields the server owns — never echo them back in an update. */
const SERVER_OWNED = new Set(["_id", "team", "createdAt", "updatedAt", "__v"]);

async function main() {
  const jwt = process.env.REDO_JWT;
  if (!jwt) throw new Error("REDO_JWT is required");
  const options: ImportOptions = { jwt, serverBase: process.env.REDO_SERVER_BASE };
  const nameFilter = process.env.NAME_FILTER?.toLowerCase();
  const ids = process.env.TEMPLATE_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
  const dryRun = !!process.env.DRY_RUN;

  const all: any[] = await postMarketingRpc("getEmailTemplates", {}, options);
  const templates = all.filter(
    (t) =>
      (!nameFilter || String(t.name ?? "").toLowerCase().includes(nameFilter)) &&
      (!ids || ids.includes(String(t._id))),
  );

  const stale = templates
    .map((t) => ({ t, urls: findKlaviyoImageUrls(t) }))
    .filter((x) => x.urls.length > 0);

  console.log(
    `${templates.length} template(s) in scope, ${stale.length} still on the Klaviyo CDN ` +
      `(${stale.reduce((n, x) => n + x.urls.length, 0)} unique asset(s))`,
  );
  if (dryRun) {
    for (const { t, urls } of stale) console.log(`  ~ ${t.name} — ${urls.length} asset(s)`);
    return;
  }

  let fixed = 0;
  const failures: Array<{ template: string; reason: string }> = [];

  for (const { t, urls } of stale) {
    const label = `${t.name ?? t._id}`;
    try {
      const { template: next, summary } = await rehostKlaviyoImages(
        t,
        (bytes, fileName, contentType) =>
          uploadAttachment(bytes, fileName, options, contentType),
        jwt,
      );

      // Send only the fields the rehost actually touched. A full echo would
      // re-validate the whole document against a schema this script never read.
      const updates: Record<string, unknown> = {};
      for (const key of Object.keys(next)) {
        if (SERVER_OWNED.has(key)) continue;
        if (JSON.stringify((next as any)[key]) !== JSON.stringify((t as any)[key])) {
          updates[key] = (next as any)[key];
        }
      }
      if (Object.keys(updates).length === 0) {
        failures.push({ template: label, reason: "nothing changed — no asset downloaded" });
        continue;
      }

      await postMarketingRpc(
        "updateEmailTemplate",
        { emailTemplateId: String(t._id), updates },
        options,
      );
      fixed++;
      const failed = summary.failed.length ? `, ${summary.failed.length} failed` : "";
      console.log(
        `  ✓ ${label} — ${summary.rehosted}/${urls.length} asset(s), ${summary.rewritten} field(s)${failed}`,
      );
      for (const f of summary.failed) console.log(`      ! ${f.url} — ${f.reason}`);
    } catch (e: any) {
      failures.push({ template: label, reason: e?.message ?? String(e) });
      console.log(`  ✗ ${label} — ${e?.message ?? e}`);
    }
  }

  console.log(`\n${fixed} template(s) updated, ${failures.length} failed`);
  for (const f of failures) console.log(`  ✗ ${f.template}: ${f.reason}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

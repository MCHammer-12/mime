// One-shot: fetch a single Klaviyo template by id, parse it, and import it
// into a Redo store via the RPC importer.
//
// Usage:
//   KLAVIYO_API_KEY=... REDO_JWT=... TEMPLATE_ID=RBksgU \
//     npx tsx src/flow/import-template-one.ts

import { fetchAccount } from "../fetch-account.js";
import { klaviyo } from "../klaviyo.js";
import { exportTemplateFromHtml } from "../export-template.js";
import {
  importTemplateRpc,
  uploadFontsForTemplates,
  type ImportProgressEvent,
} from "../migrate/import-rpc.js";

async function main() {
  const klaviyoKey = process.env.KLAVIYO_API_KEY;
  const redoJwt = process.env.REDO_JWT;
  const templateId = process.env.TEMPLATE_ID;
  const skipAi = process.env.SKIP_AI === "1" || !process.env.ANTHROPIC_API_KEY;

  if (!klaviyoKey) throw new Error("KLAVIYO_API_KEY not set");
  if (!redoJwt) throw new Error("REDO_JWT not set");
  if (!templateId) throw new Error("TEMPLATE_ID not set");

  console.log(`[1/4] fetching template ${templateId}...`);
  const detail = await klaviyo(`/templates/${templateId}/`, klaviyoKey);
  const attrs = detail.data?.attributes ?? {};
  const html = String(attrs.html ?? "");
  if (!html) throw new Error("template has no HTML");
  console.log(`      "${attrs.name}" [${attrs.editor_type}]  (${html.length} bytes html)`);

  console.log(`[2/4] fetching Klaviyo account...`);
  let account = null;
  try {
    account = await fetchAccount(klaviyoKey);
    console.log(`      ${account.organizationName}`);
  } catch (e: any) {
    console.warn(`      skipped (${e.message})`);
  }

  console.log(`[3/4] parsing template...`);
  const result = await exportTemplateFromHtml(
    html,
    {
      name: attrs.name,
      subject: attrs.name,
      editorType: attrs.editor_type,
      created: attrs.created,
    },
    { account, skipAi },
  );
  console.log(`      sections: ${result.sectionCount}`);
  if (result.warnings.length > 0) console.log(`      warnings: ${result.warnings.length}`);
  if (result.unsupportedFeatures.length > 0) console.log(`      unsupported: ${result.unsupportedFeatures.length}`);
  if (result.reviewItems.length > 0) console.log(`      review: ${result.reviewItems.length}`);
  if (result.fontPlan.hasUnresolved) console.log(`      font unresolved`);

  console.log(`[4/4] importing into Redo...`);
  const audTeamId = decodeJwtAud(redoJwt);
  if (audTeamId) console.log(`      target store: ${audTeamId}`);

  const onProgress = (e: ImportProgressEvent) => {
    switch (e.kind) {
      case "template_created":
        console.log(`      ✓ template "${e.templateName}" → ${e.templateId}`);
        break;
      case "template_failed":
        console.log(`      ✗ template "${e.templateName}": ${e.error}`);
        break;
      case "font_uploading":
        console.log(`      uploading font ${e.family}/${e.fileName}`);
        break;
      case "font_registered":
        console.log(`      ✓ font ${e.family}`);
        break;
      case "fonts_done":
        console.log(`      fonts: ${e.uploaded} uploaded, ${e.skipped} skipped`);
        break;
    }
  };

  const options = { jwt: redoJwt, account, onProgress };

  // Try font upload first (non-fatal if it fails against a fresh brand kit).
  try {
    const fontResult = await uploadFontsForTemplates([result.template], options);
    if (fontResult.unresolved.length > 0) {
      console.log(`      unresolved fonts:`);
      for (const u of fontResult.unresolved) {
        console.log(`        - ${u.family} (${u.reason})`);
      }
    }
  } catch (e: any) {
    console.warn(`      font upload failed (non-fatal): ${e.message ?? e}`);
  }

  try {
    const created = await importTemplateRpc(result.template, options);
    console.log(`\ndone.`);
    console.log(`  template id:  ${created.templateId}`);
    console.log(`  name:         ${created.name}`);
  } catch (e: any) {
    console.error(`\nimport failed: ${e.message ?? e}`);
    process.exit(1);
  }
}

function decodeJwtAud(jwt: string): string | null {
  try {
    const [, payload] = jwt.split(".");
    if (!payload) return null;
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    const aud = json.aud as string | undefined;
    if (!aud) return null;
    return aud.startsWith("mcht/") ? aud.slice("mcht/".length) : aud;
  } catch {
    return null;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

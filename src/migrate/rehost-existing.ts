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
  getTeam,
  postMarketingRpc,
  uploadAttachment,
  type ImportOptions,
} from "./import-rpc.js";
import { findKlaviyoImageUrls, KLAVIYO_ASSET_HOST, rehostKlaviyoImages } from "./rehost-images.js";

/** Fields the server owns — never echo them back in an update. */
const SERVER_OWNED = new Set(["_id", "team", "createdAt", "updatedAt", "__v"]);

type Merchant = { name: string; url: string };

/** Redo's storeUrl is the myshopify host; the customer-facing domain is
 *  wherever Shopify redirects it (blacklinedetailing.myshopify.com →
 *  blacklinecarcare.com). Same answer as Klaviyo's organization.url. */
async function resolveMerchant(options: ImportOptions): Promise<Merchant> {
  const me = await getTeam(options);
  const team = me?.team ?? me;
  const name = String(team?.name ?? "").trim();
  const host = String(team?.storeUrl ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  let url = host ? `https://${host}` : "";
  try {
    if (url) url = new URL((await fetch(url, { method: "HEAD", redirect: "follow" })).url).origin;
  } catch {}
  return { name, url };
}

/** `… uses {{ organization }}, which the Marketing email trigger doesn't
 *  provide` — one clause per offending token; pull the roots. */
function rejectedRoots(message: string): string[] {
  return [...new Set([...message.matchAll(/uses \{\{ (\w+) \}\}/g)].map((m) => m[1]!))];
}

/**
 * updateEmailTemplate validates every {{ token }} against the template's
 * schemaType and rejects the whole document on one unknown root — so a
 * template that was accepted at import can refuse an unrelated image swap.
 * Resolve the roots we know are merchant constants or plain renames; leave
 * anything else for the operator. Returns whether any string changed.
 */
function fixRejectedRoots(template: any, roots: string[], merchant: Merchant): boolean {
  const rules: Array<[RegExp, string | ((...m: string[]) => string)]> = [];
  const schema = String(template.schemaType ?? "");
  // Klaviyo filters that leave a merchant constant unchanged: the url carries
  // no trailing slash and the name is never empty.
  const noop = String.raw`(?:\|\s*(?:trim_slash|default:[^|}]*)\s*)*`;
  if (roots.includes("organization") && merchant.name) {
    // "Welcome to the {{ organization.name }}" with a team named "The Pretty
    // Cult" would read "the The Pretty Cult" — drop the article once.
    rules.push([
      new RegExp(String.raw`\b(the\s+)\{\{\s*organization\.name\s*${noop}\}\}`, "gi"),
      (_, the) => the + merchant.name.replace(/^the\s+/i, ""),
    ]);
    rules.push([new RegExp(String.raw`\{\{\s*organization\.name\s*${noop}\}\}`, "g"), merchant.name]);
    if (merchant.url) {
      rules.push([
        new RegExp(String.raw`\{\{\s*organization\.(?:url|website|website_url)\s*${noop}\}\}`, "g"),
        merchant.url,
      ]);
    }
  }
  // Plain renames; the filter chain carries over.
  const rename = (from: string, to: string, flags = "g") =>
    rules.push([
      new RegExp(String.raw`\{\{\s*${from}\s*(\|[^}]*?)?\s*\}\}`, flags),
      (_, filters) => `{{ ${to}${filters ? " " + filters : ""} }}`,
    ]);
  // `{{ First_name }}` never resolved in Klaviyo either; same intent.
  if (roots.some((r) => r.toLowerCase() === "first_name")) rename("first_name", "customer_first_name", "gi");
  if (roots.includes("email")) rename("email", "customer_email");
  // Abandonment triggers expose one link back to the cart or the browsed
  // page, which Klaviyo spells several ways per metric. On any other trigger
  // event.* is a mismatch the operator has to decide on, so it stays.
  if (roots.includes("event")) {
    // `https://shop.com{{ event.URL|cut:"https://shop.com" }}` — the same link,
    // written to survive a relative URL. Unwrap before the rename.
    rules.push([/(https?:\/\/[^\s{"']+)\{\{\s*event\.URL\|cut:"\1"\s*\}\}/g, "{{ event.URL }}"]);
    if (schema === "marketing_cart_abandonment" || schema === "marketing_checkout_abandonment") {
      rename(String.raw`event(?:\.URL|\.checkout_url|\.extra\.(?:responsive_)?checkout_url)`, "checkout_url");
    }
    if (schema === "marketing_browse_abandonment") {
      rename(String.raw`event(?:\.URL|\|lookup:["']Url["'])`, "browsed_page_url");
    }
  }
  // Klaviyo fetches the restocked item with {% catalog %}; Redo's back-in-stock
  // trigger hands the same URL over flat.
  if (roots.includes("catalog_item") && schema === "marketing_back_in_stock") {
    rules.push([
      /\{%\s*catalog\s+event\.VariantId\b[^%]*%\}\s*\{\{\s*catalog_item\.url\s*\}\}\s*\{%\s*endcatalog\s*%\}/g,
      "{{ back_in_stock_product_url }}",
    ]);
  }
  // An older importer resolved organization.name *inside* the braces, leaving
  // `{{ Blackline Car Care }}` — reported as root `Blackline`.
  if (merchant.name && roots.includes(merchant.name.split(/\s+/)[0]!)) {
    const escaped = merchant.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    rules.push([new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`, "g"), merchant.name]);
  }
  if (rules.length === 0) return false;

  let changed = false;
  const visit = (node: any): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        if (typeof v === "string") {
          const out = rules.reduce((s, [re, to]) => s.replace(re, to as string), v);
          if (out !== v) { node[i] = out; changed = true; }
        } else visit(v);
      });
    } else if (node && typeof node === "object") {
      for (const k of Object.keys(node)) {
        if (k === "name" || SERVER_OWNED.has(k)) continue;
        const v = node[k];
        if (typeof v === "string") {
          const out = rules.reduce((s, [re, to]) => s.replace(re, to as string), v);
          if (out !== v) { node[k] = out; changed = true; }
        } else visit(v);
      }
    }
  };
  visit(template);
  return changed;
}

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

  const elsewhere = templates.filter(
    (t) => JSON.stringify(t).includes(KLAVIYO_ASSET_HOST) && findKlaviyoImageUrls(t).length === 0,
  ).length;
  console.log(
    `${templates.length} template(s) in scope, ${stale.length} still on the Klaviyo CDN ` +
      `(${stale.reduce((n, x) => n + x.urls.length, 0)} unique asset(s))` +
      (elsewhere ? `, ${elsewhere} reference it outside image blocks (not touched)` : ""),
  );
  if (dryRun) {
    for (const { t, urls } of stale) console.log(`  ~ ${t.name} — ${urls.length} asset(s)`);
    return;
  }

  let fixed = 0;
  const failures: Array<{ template: string; reason: string }> = [];
  let merchant: Merchant | undefined;

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
      const diff = (): Record<string, unknown> => {
        const updates: Record<string, unknown> = {};
        for (const key of Object.keys(next)) {
          if (SERVER_OWNED.has(key)) continue;
          if (JSON.stringify((next as any)[key]) !== JSON.stringify((t as any)[key])) {
            updates[key] = (next as any)[key];
          }
        }
        return updates;
      };
      if (Object.keys(diff()).length === 0) {
        failures.push({ template: label, reason: "nothing changed — no asset downloaded" });
        continue;
      }

      const update = () =>
        postMarketingRpc(
          "updateEmailTemplate",
          { emailTemplateId: String(t._id), updates: diff() },
          options,
        );
      let resolvedRoots: string[] = [];
      try {
        await update();
      } catch (e: any) {
        const roots = rejectedRoots(e?.message ?? "");
        merchant ??= await resolveMerchant(options);
        if (roots.length === 0 || !fixRejectedRoots(next, roots, merchant)) throw e;
        resolvedRoots = roots;
        await update();
      }
      fixed++;
      const failed = summary.failed.length ? `, ${summary.failed.length} failed` : "";
      const liquid = resolvedRoots.length ? `, resolved {{ ${resolvedRoots.join(" }}, {{ ")} }}` : "";
      console.log(
        `  ✓ ${label} — ${summary.rehosted}/${urls.length} asset(s), ${summary.rewritten} field(s)${failed}${liquid}`,
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

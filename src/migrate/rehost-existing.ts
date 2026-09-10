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

type Merchant = { name: string; url: string; address: string };

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
  // Same source order as Redo's own footer block: the custom footer address,
  // else the public one, else the account address.
  const footer = team?.settings?.emailFooter;
  const a = (footer?.useCustomAddress && footer.customAddress) || team?.publicAddress || team?.address || {};
  const address = [
    [a.street1, a.street2].filter(Boolean).join(" "),
    a.city,
    [a.state, a.zip].filter(Boolean).join(" "),
    a.country || team?.address?.country_name,
  ]
    .filter(Boolean)
    .join(", ");
  return { name, url, address };
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
 *
 * Two passes. First, tokens with a Redo equivalent are renamed to it and
 * merchant constants are inlined, anywhere in the document. Then whatever
 * still carries a rejected root on a site the validator reads (subject,
 * preview, text/html, links) falls back: the token's own `|default:` literal
 * if it has one, else "" in copy and the trigger's natural link in a URL.
 * Returns one line per distinct replacement; empty means nothing changed.
 */
function fixRejectedRoots(template: any, roots: string[], merchant: Merchant): string[] {
  const schema = String(template.schemaType ?? "");
  const has = (...names: string[]) => roots.some((r) => names.includes(r.toLowerCase()));
  // Pick the trigger's own name for a concept; marketing_email and
  // marketing_campaign share the renderer-provided "most recently viewed"
  // product, the closest thing they have to an event payload.
  const by = (m: Record<string, string>): string | undefined =>
    m[schema] ?? (schema === "marketing_email" || schema === "marketing_campaign" ? m.marketing : undefined);
  const abandonment = schema === "marketing_cart_abandonment" || schema === "marketing_checkout_abandonment";

  // [pattern, replacement, copyOnly]. A copy-only rule swaps in a product
  // name or price — fine in copy, but inside a link it just renders a broken
  // URL. There the token is left for the url pass below, which takes the
  // Klaviyo default (in practice a /cart link) or the schema's own link.
  const rules: Array<[RegExp, (...m: any[]) => string, boolean?]> = [];
  const LINK_KEYS = new Set(["buttonLink", "clickthroughUrl", "url", "src"]);
  const token = (body: string, flags = "g") =>
    new RegExp(String.raw`\{\{\s*${body}\s*(\|[^}]*?)?\s*\}\}`, flags);
  // A Redo variable stands in; the filter chain carries over.
  const rename = (from: string, to: string, flags = "g", copyOnly = false) =>
    rules.push([token(from, flags), (_, filters) => `{{ ${to}${filters ? " " + filters : ""} }}`, copyOnly]);
  const renameCopy = (from: string, to: string) => rename(from, to, "g", true);
  // A merchant constant stands in; the filters go with the token.
  const literal = (from: string, value: string) => rules.push([token(from), () => value]);

  if (has("organization")) {
    if (merchant.name) {
      // "Welcome to the {{ organization.name }}" with a team named "The Pretty
      // Cult" would read "the The Pretty Cult" — drop the article once.
      rules.push([
        new RegExp(String.raw`\b(the\s+)\{\{\s*organization\.name\s*(?:\|[^}]*)?\}\}`, "gi"),
        (_, the) => the + merchant.name.replace(/^the\s+/i, ""),
      ]);
      literal(String.raw`organization\.name`, merchant.name);
    }
    if (merchant.url) literal(String.raw`organization\.(?:url|website|website_url)`, merchant.url);
    if (merchant.address) literal(String.raw`organization\.full_address`, merchant.address);
  }
  // `{{ First_name }}` / `{{ first name }}` never resolved in Klaviyo either; same intent.
  if (has("first_name", "first")) rename(String.raw`first[\s_]name`, "customer_first_name", "gi");
  if (has("email")) rename("email", "customer_email");
  if (has("person")) {
    rename(String.raw`person\.first_name`, "customer_first_name");
    rename(String.raw`person\.email`, "customer_email");
    if (schema !== "yotpo_loyalty_points_earned") rename(String.raw`person\.last_name`, "customer_last_name");
  }
  // Klaviyo's preference-centre links all collapse to Redo's one unsubscribe.
  if (has("unsubscribe_url", "manage_preferences_link", "preferences_link", "email_preference_url")) {
    rename("(?:unsubscribe_url|manage_preferences_link|preferences_link|email_preference_url)", "unsubscribe_link");
  }
  // A bare "click below to stay subscribed" link: any tracked click counts as
  // engagement in Redo, so send it to the store.
  if (has("link")) rename("link", "store_link");

  if (has("event")) {
    // `https://shop.com{{ event.URL|cut:"https://shop.com" }}` — the same link,
    // written to survive a relative URL. Unwrap before the rename.
    rules.push([/(https?:\/\/[^\s{"']+)\{\{\s*event\.URL\|cut:"\1"\s*\}\}/g, () => "{{ event.URL }}"]);
    const cartish = String.raw`event(?:\.checkout_url|\.extra\.(?:responsive_)?checkout_url|\.extra\.cart_url)`;
    if (abandonment) rename(String.raw`(?:event\.URL|${cartish})`, "checkout_url");
    else if (by({ marketing: "1" }) && merchant.url) literal(cartish, `${merchant.url}/cart`);
    if (schema === "marketing_browse_abandonment") rename(String.raw`event\|lookup:["']Url["']`, "browsed_page_url");
    const link = by({
      marketing_cart_abandonment: "checkout_url",
      marketing_checkout_abandonment: "checkout_url",
      marketing_browse_abandonment: "browsed_page_url",
      marketing_price_drop: "discounted_product.url",
      marketing_back_in_stock: "back_in_stock_product_url",
      marketing: "most_recently_viewed_product_link",
    });
    if (link) rename(String.raw`event(?:\.URL|\.url|\.product_url|\.page|\.items\.0\.url)`, link);
    const name = by({
      marketing_cart_abandonment: "product_in_cart_name",
      marketing_checkout_abandonment: "product_in_cart_name",
      marketing_browse_abandonment: "most_recently_viewed_product_name",
      marketing_price_drop: "product_title",
      marketing_back_in_stock: "back_in_stock_product_title",
      marketing: "most_recently_viewed_product_name",
    });
    if (name) {
      renameCopy(
        String.raw`event(?:\.Name|\.Title|\.product_name|\.product_title|\.product\.title|\.structured_product\.title|\.extra\.line_items\.0\.product\.title|\s*\|\s*lookup:["']Product Name["'])`,
        name,
      );
    }
    if (schema === "marketing_price_drop") {
      renameCopy(String.raw`event\.price_drop_percent`, "formatted_price_drop_percentage");
      renameCopy(String.raw`event\.reduced_price`, "formatted_current_price");
      renameCopy(String.raw`event\.original_price`, "formatted_previous_price");
      renameCopy(String.raw`event\.price_drop_amount`, "formatted_savings");
    }
    if (schema === "order_tracking") {
      rename(String.raw`event\.extra\.(?:order_number|order\.name|order\.meta\.shopify_order\.name)`, "order_number");
      rename(String.raw`event\.(?:carrier_name|extra\.fulfillments?(?:\.0)?\.tracking_company)`, "carrier");
      rename(String.raw`event\.(?:tracking_code|extra\.fulfillments?(?:\.0)?\.tracking_number)`, "tracking_number");
      rename(
        String.raw`event\.extra\.(?:fulfillments?(?:\.0)?\.tracking_url|order_status_url|order\.(?:url|order_status_url|meta\.shopify_order\.order_status_url))`,
        "tracking_link",
      );
    }
    rename(String.raw`event\.(?:extra\.(?:customer\.default_address|(?:shipping|billing)_address)\.)?first_name`, "customer_first_name");
  }
  if (schema === "order_tracking") {
    if (has("fulfillment")) {
      rename(String.raw`fulfillment\.tracking_company`, "carrier");
      rename(String.raw`fulfillment\.tracking_numbers\.first`, "tracking_number");
      rename(String.raw`fulfillment\.tracking_urls\.first`, "tracking_link");
    }
    if (has("tracking_url")) rename("tracking_url", "tracking_link");
    // Order address parts live under order_summary, whichever of Klaviyo's
    // three spellings the template used.
    if (has("event", "shipping_address", "billing_address")) {
      const field: Record<string, string> = {
        name: "name", address1: "address1", address2: "address2", city: "city",
        province: "province", state: "province", zip: "postal_code", postal_code: "postal_code", phone: "phone",
        last_name: "", // no per-address last name; the customer's own is below
      };
      rules.push([
        new RegExp(
          String.raw`\{\{\s*(?:event\.extra\.(?:order\.(?:meta\.shopify_order\.)?)?)?(shipping|billing)(?:_address|Address)\.(${Object.keys(field).join("|")})\s*(\|[^}]*?)?\s*\}\}`,
          "g",
        ),
        (m, kind, part, filters) => {
          const to = part === "last_name" ? "customer_last_name" : `order_summary.customer_information.${kind}_address.${field[part]}`;
          return `{{ ${to}${filters ? " " + filters : ""} }}`;
        },
      ]);
    }
  }
  // Klaviyo fetches the item with {% catalog %}; Redo's triggers hand the same
  // fields over flat, so the wrapper goes too (LiquidJS would choke on it).
  if (has("catalog_item")) {
    const product = by({ marketing_price_drop: "discounted_product", marketing_back_in_stock: "restocked_product" });
    if (product) {
      rules.push([/\{%\s*catalog\b[^%]*%\}\s*/g, () => ""], [/\s*\{%\s*endcatalog\s*%\}/g, () => ""]);
      renameCopy(String.raw`catalog_item\.title`, `${product}.title`);
      rename(String.raw`catalog_item\.url`, `${product}.url`);
      rename(String.raw`catalog_item(?:\.variant)?\.featured_image\.full\.src`, `${product}.image_url`);
      renameCopy(String.raw`catalog_item(?:\.variant)?\.price`, `${product}.price`);
    }
  }
  // An older importer resolved organization.name *inside* the braces, leaving
  // `{{ Blackline Car Care }}` — reported as root `Blackline`.
  if (merchant.name && roots.includes(merchant.name.split(/\s+/)[0]!)) {
    const escaped = merchant.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    rules.push([new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`, "g"), () => merchant.name]);
  }

  const log = new Set<string>();
  const note = (from: string, to: string) => log.add(`${from} → ${to === "" ? '""' : to}`);
  const apply = (s: string, key: string) =>
    rules.reduce(
      (acc, [re, to, copyOnly]) =>
        copyOnly && LINK_KEYS.has(key)
          ? acc
          : acc.replace(re, (...m: any[]) => {
              const out = to(...m);
              if (out !== m[0]) note(m[0], out);
              return out;
            }),
      s,
    );
  const visit = (node: any, key = ""): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        if (typeof v === "string") node[i] = apply(v, key);
        else visit(v, key);
      });
    } else if (node && typeof node === "object") {
      for (const k of Object.keys(node)) {
        if (k === "name" || SERVER_OWNED.has(k)) continue;
        const v = node[k];
        if (typeof v === "string") node[k] = apply(v, k);
        else visit(v, k);
      }
    }
  };
  visit(template);

  // Fallbacks, only where the validator looks. Anything left in altText,
  // buttonText or an imageUrl is not what blocked the save.
  const TOKEN = /\{\{\s*([^}]*?)\s*\}\}/g;
  const rejected = new Set(roots);
  const rootOf = (body: string) => body.match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0] ?? "";
  const defaultOf = (body: string) => {
    const m = body.match(/\|\s*default:\s*(?:'([^']*)'|"([^"]*)")/);
    return m ? (m[1] ?? m[2] ?? "") : undefined;
  };
  const link =
    by({
      marketing_cart_abandonment: "{{ checkout_url }}",
      marketing_checkout_abandonment: "{{ checkout_url }}",
      marketing_browse_abandonment: "{{ browsed_page_url }}",
      marketing_price_drop: "{{ discounted_product.url }}",
      marketing_back_in_stock: "{{ back_in_stock_product_url }}",
      order_tracking: "{{ tracking_link }}",
    }) ?? merchant.url;
  const fallback = (holder: any, key: string, kind: "text" | "url") => {
    const s = holder?.[key];
    if (typeof s !== "string") return;
    let out = s.replace(TOKEN, (m, body) => {
      if (!rejected.has(rootOf(body))) return m;
      const d = defaultOf(body);
      if (d !== undefined && (kind === "text" || d)) {
        note(m, `"${d}"`);
        return d;
      }
      if (kind === "text") {
        note(m, "");
        return "";
      }
      return m;
    });
    // A link is one value: a rejected root anywhere in it means the whole
    // thing goes, never `https://shop.com/products/` with a hole in it.
    if (kind === "url" && link && [...out.matchAll(TOKEN)].some(([, body]) => rejected.has(rootOf(body)))) {
      note(out, link);
      out = link;
    }
    if (out !== s) holder[key] = out;
  };
  const savedSections: string[] = [];
  const blocks = (list: any[]): void => {
    for (const b of list ?? []) {
      switch (b?.type) {
        case "text": fallback(b, "text", "text"); break;
        case "html": fallback(b, "html", "text"); break;
        case "button": fallback(b, "buttonLink", "url"); break;
        case "image":
        case "header": fallback(b, "clickthroughUrl", "url"); break;
        case "qr-code-email": fallback(b, "url", "url"); break;
        case "menu": for (const item of b.menuItems ?? []) fallback(item, "label", "text"); break;
        case "table":
          // Dynamic rows bind {{ item }} alone; nothing from the trigger belongs there.
          if (b.mode !== "static") break;
          for (const row of b.staticRows ?? []) {
            for (const cell of row ?? []) {
              if (cell?.cellType === "image") { fallback(cell, "src", "url"); fallback(cell, "clickthroughUrl", "url"); }
              else fallback(cell, "content", "text");
            }
          }
          break;
        case "column": blocks(b.columns); break;
        case "interactive-review-request": blocks(b.successSection?.blocks); break;
        case "section-reference": savedSections.push(String(b.sectionId)); break;
      }
    }
  };
  fallback(template, "subject", "text");
  fallback(template, "emailPreview", "text");
  blocks(template.sections);
  // A saved section is shared by every email that references it; fixing one
  // email must not edit it. The retry names the section if that's the blocker.
  if (savedSections.length) log.add(`saved section(s) ${savedSections.join(", ")} not touched`);
  return log.size ? [...log] : [];
}

async function main() {
  const jwt = process.env.REDO_JWT;
  if (!jwt) throw new Error("REDO_JWT is required");
  const options: ImportOptions = { jwt, serverBase: process.env.REDO_SERVER_BASE };
  const nameFilter = process.env.NAME_FILTER?.toLowerCase();
  const ids = process.env.TEMPLATE_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
  const dryRun = !!process.env.DRY_RUN;

  // getEmailTemplates is the list-view RPC and hides campaign templates
  // (schemaType marketing_campaign); getEmailTemplatesByTeam returns the
  // whole team, which is what the CRDB scan counts.
  const byTeam = await postMarketingRpc("getEmailTemplatesByTeam", {}, options);
  const all: any[] = byTeam.data ?? byTeam;
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
      let replacements: string[] = [];
      try {
        await update();
      } catch (e: any) {
        const roots = rejectedRoots(e?.message ?? "");
        merchant ??= await resolveMerchant(options);
        replacements = roots.length ? fixRejectedRoots(next, roots, merchant) : [];
        if (replacements.length === 0) throw e;
        resolvedRoots = roots;
        try {
          await update();
        } catch (e2: any) {
          for (const r of replacements) console.log(`      ↳ ${r}`);
          throw e2;
        }
      }
      fixed++;
      const failed = summary.failed.length ? `, ${summary.failed.length} failed` : "";
      const liquid = resolvedRoots.length ? `, resolved {{ ${resolvedRoots.join(" }}, {{ ")} }}` : "";
      console.log(
        `  ✓ ${label} — ${summary.rehosted}/${urls.length} asset(s), ${summary.rewritten} field(s)${failed}${liquid}`,
      );
      for (const f of summary.failed) console.log(`      ! ${f.url} — ${f.reason}`);
      for (const r of replacements) console.log(`      ↳ ${r}`);
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

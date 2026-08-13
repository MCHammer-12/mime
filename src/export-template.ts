/**
 * Export a Klaviyo template as a complete Redo EmailTemplate JSON object.
 *
 * This produces the exact same structure that lives in Redo's MongoDB —
 * ready to show to the eng team or POST to the Redo API.
 *
 * Usage:
 *   KLAVIYO_API_KEY=pk_... npx tsx src/export-template.ts <template.html> [template.json]
 *
 * The optional .json arg is the Klaviyo API response (for name, subject, etc.)
 * If omitted, defaults are used.
 *
 * KLAVIYO_API_KEY enables account-level variable substitution (org name,
 * address, unsubscribe link, website URL). Without it, variables stay as-is.
 */

import { readFileSync, writeFileSync } from "fs";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ObjectId } from "bson";
import * as cheerio from "cheerio";
import { parseKlaviyoHtml } from "./parser/index.js";
import { parseCodeTemplateHtml } from "./parser/code-template.js";
import { fetchAccount, type KlaviyoAccount } from "./fetch-account.js";
import { transformSections, substituteStringVars } from "./transform.js";
import { formatAddress } from "./fetch-account.js";
import { buildFontPlan } from "./fonts.js";

export interface ExportResult {
  outPath: string;
  name: string;
  sectionCount: number;
  substitutions: string[];
  aiRewrites: number;
  aiUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
  warnings: string[];
  unsupportedFeatures: { blockType: string; reason: string; context: string }[];
  reviewItems: { blockType: string; variableName: string; context: string }[];
  skippedBlocks: { blockType: string; reason: string }[];
  fontPlan: Awaited<ReturnType<typeof buildFontPlan>>;
}

export interface TemplateMetadata {
  name?: string;
  subject?: string;
  created?: string;
  editorType?: string;
}

/** The units parseKlaviyoHtml walks — everything outside them is invisible to it. */
const KL_SKELETON =
  ".kl-row, .gxp-kl-row, .component-wrapper, .root-container, #bodyTable";

/**
 * Fraction of the document's visible text that sits inside Klaviyo's own
 * skeleton — i.e. how much of the email the kl parser can even see.
 *
 * Testing for kl-* classes anywhere is not enough. Merchants routinely build in
 * another tool (Stripo, Beefree) and paste a single Klaviyo product block into
 * the result. That document has kl-* classes but no skeleton around the rest of
 * it, so the kl parser walks the one pasted block and drops the other 60-odd
 * tables on the floor. Six of Relay Goods' ten emails imported all but empty
 * this way, and they measure 0-36% here against 100% for a native document.
 */
function klSkeletonCoverage(html: string): number {
  const $ = cheerio.load(html);
  $("script,style,head").remove();
  const len = (s: string) =>
    s.replace(/&nbsp;|[​‌­͏]/g, " ").replace(/\s+/g, " ").trim().length;
  const total = len($("body").text());
  if (total === 0) return 1;
  let inside = 0;
  $(KL_SKELETON)
    .filter((_, e) => $(e).parents(KL_SKELETON).length === 0)
    .each((_, e) => {
      inside += len($(e).text());
    });
  return inside / total;
}

/**
 * Visible text length of the source document, for parser coverage checks.
 * Product-feed markup is excluded: its Liquid (`{% for item in feeds… %}`,
 * `{{ Title }}`) becomes a single dynamic-products block rather than literal
 * text, so counting it would make a correct parse of a product email look like
 * it lost 90% of its content.
 */
function sourceTextLength(html: string): number {
  const $ = cheerio.load(html);
  $("script,style,head,[class*='kl-product']").remove();
  return $("body")
    .text()
    .replace(/&nbsp;|[​‌­͏]/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

/** Visible text length recovered into parsed sections. */
function recoveredTextLength(sections: unknown): number {
  let total = 0;
  const walk = (o: any): void => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return void o.forEach(walk);
    if (typeof o.text === "string")
      total += o.text.replace(/<[^>]*>/g, "").trim().length;
    for (const v of Object.values(o)) walk(v);
  };
  walk(sections);
  return total;
}

export interface ExportFromHtmlResult
  extends Omit<ExportResult, "outPath"> {
  template: Record<string, any>;
}

/**
 * Pure variant — takes raw HTML + metadata, returns the full EmailTemplate
 * JSON without touching disk. Used by the flow parser to inline real email
 * content into flow imports (see src/flow/template-resolver.ts). The CLI
 * wrapper `exportTemplate()` just reads from disk and delegates here.
 */
export async function exportTemplateFromHtml(
  html: string,
  meta: TemplateMetadata,
  opts: { account: KlaviyoAccount | null; skipAi: boolean },
): Promise<ExportFromHtmlResult> {
  // Route to the appropriate parser. The default parser keys entirely on
  // kl-*/gxp-kl-* block classes. CODE and SIMPLE templates have none — CODE is
  // hand-coded HTML; SIMPLE is plain <div>/<span> text (Jack Henry's
  // abandoned-cart emails, "Hi {{ first_name }}, you left a few things behind").
  // Both must use the non-class CODE parser, which extracts text/image/button
  // from arbitrary HTML. Belt-and-braces: ANY zero-kl-class HTML routes there
  // too — the kl parser can only ever yield 0 sections (a blank email) on it,
  // which is exactly the silent-blank bug (2 of Jack Henry's 8 emails).
  const useCodeParser =
    meta.editorType === "CODE" ||
    meta.editorType === "SIMPLE" ||
    klSkeletonCoverage(html) < 0.7;
  const {
    sections: rawSections,
    warnings,
    unsupportedFeatures,
    reviewItems,
    skippedBlocks,
    bodyBackgroundColor,
  } = useCodeParser
    ? parseCodeTemplateHtml(html, { storeUrl: opts.account?.websiteUrl ?? null })
    : parseKlaviyoHtml(html, { storeUrl: opts.account?.websiteUrl ?? null });

  // Never silently ship a blank: if the chosen parser produced nothing, say so
  // (names the editor_type so a "blank email" report is self-diagnosing — pairs
  // with the import-side blank-reason surfacing).
  if (rawSections.length === 0) {
    warnings.push(
      `Template parsed to 0 sections (editor_type=${meta.editorType ?? "unknown"}, ${useCodeParser ? "code" : "kl"} parser) — the imported email will be blank. Review the source template.`,
    );
  } else {
    // A near-empty parse is the same failure as a blank one but slips through
    // silently — the email imports, looks like a success, and only a human
    // eyeballing it in Redo notices the body is gone. Flag it at import.
    const srcLen = sourceTextLength(html);
    const gotLen = recoveredTextLength(rawSections);
    if (srcLen >= 400 && gotLen < srcLen * 0.25) {
      warnings.push(
        `Template recovered only ${Math.round((100 * gotLen) / srcLen)}% of its text (${gotLen}/${srcLen} chars, editor_type=${meta.editorType ?? "unknown"}, ${useCodeParser ? "code" : "kl"} parser) — the imported email is probably missing most of its content. Review it before enabling.`,
      );
    }
  }

  let sections = rawSections;
  let substitutions: string[] = [];
  let aiRewrites = 0;
  let aiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const allWarnings = [...warnings];

  // transformSections handles: organization variable substitution (needs
  // account), inline-coupon detection → DiscountBlock insertion (runs
  // regardless of account), and button-link substitutions. Always run it
  // so coupons get handled even when the Klaviyo account fetch failed.
  {
    const result = await transformSections(rawSections, opts.account, {
      skipAi: opts.skipAi,
    });
    sections = result.sections;
    substitutions = result.substitutions;
    aiRewrites = result.aiRewrites;
    aiUsage = result.aiUsage;
    allWarnings.push(...result.warnings);
  }

  clampNegativePadding(sections, allWarnings);

  const fontPlan = await buildFontPlan(sections);

  // Apply org / shop / customer-profile substitutions to the subject line
  // and (eventually) preview text. Klaviyo subjects routinely use
  // {{ organization.name }} / {{ first_name }} which Redo's runtime doesn't
  // resolve — substitute at import.
  const subVarCtx = {
    orgName: opts.account?.organizationName ?? "",
    orgAddress: opts.account ? formatAddress(opts.account) : "",
    orgUrl: opts.account?.websiteUrl ?? "",
  };
  const transformedSubject = meta.subject
    ? substituteStringVars(meta.subject, subVarCtx, substitutions)
    : "";

  const name = meta.name || "Imported Template";

  // Historically: if any block referenced the `checkoutUrl` dynamic var,
  // we marked the template as `marketing_checkout_abandonment` so the
  // schema-instance resolver knew what to do at send time. We no longer
  // emit `checkoutUrl` dynamic vars (Redo eng confirmed they resolve to
  // a Storefront URL that's silently null on cart-fetch failure — see
  // url-mapping.ts), so this never fires anymore. Templates land as
  // plain `marketing_email`, which is the more reusable schema. Left
  // the helper in place in case product blocks reintroduce
  // `clickthroughSchemaFieldName: "checkoutUrl"` later.
  const schemaType = referencesCheckoutUrl(sections)
    ? "marketing_checkout_abandonment"
    : "marketing_email";

  const template = {
    _id: new ObjectId().toString(),
    name,
    subject: transformedSubject,
    templateType: "marketing",
    category: "Marketing",
    schemaType,
    emailPreview: null,
    emailBackgroundColor: bodyBackgroundColor,
    contentBackgroundColor: "#ffffff",
    address: {
      businessAddress: "Business Name",
      legalAddress: "123 Main St",
      cityStateZip: "City, ST 12345",
      country: "United States",
    },
    sections,
    linkColor: "#0000ee",
    team: null,
    createdAt: meta.created || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isPlainText: false,
    _fontPlan: fontPlan,
  };

  return {
    template,
    name,
    sectionCount: sections.length,
    substitutions,
    aiRewrites,
    aiUsage,
    warnings: allWarnings,
    unsupportedFeatures,
    reviewItems,
    skippedBlocks,
    fontPlan,
  };
}

/**
 * Redo's template schema rejects negative padding (`>= 0`), but Klaviyo emits
 * it — every Diamond MMA footer pulls the social row up with
 * `padding-top:-10px`, which 400s the whole import. Clamp to 0 and warn: the
 * affected block lands that many pixels lower than it did in Klaviyo.
 */
function clampNegativePadding(sections: unknown, warnings: string[]): void {
  const fixes: string[] = [];
  const walk = (node: any, type: string): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, type);
      return;
    }
    const t = typeof node.type === "string" ? node.type : type;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      if (/padding$/i.test(key)) {
        for (const side of Object.keys(value)) {
          if (typeof value[side] === "number" && value[side] < 0) {
            fixes.push(`${t} ${key}.${side} ${value[side]}px`);
            value[side] = 0;
          }
        }
      }
      walk(value, t);
    }
  };
  walk(sections, "?");
  if (fixes.length > 0) {
    warnings.push(
      `Clamped ${fixes.length} negative padding value(s) to 0 — Redo's schema ` +
        `rejects them (${fixes.join(", ")}). Those blocks sit slightly lower ` +
        `than in Klaviyo.`,
    );
  }
}

/**
 * Core per-template export. Pass a pre-fetched `account` (or null to skip
 * variable substitution). `skipAi` suppresses the inline-coupon LLM call.
 */
export async function exportTemplate(
  htmlPath: string,
  opts: { account: KlaviyoAccount | null; skipAi: boolean },
): Promise<ExportResult> {
  const html = readFileSync(htmlPath, "utf-8");

  // Infer metadata from a sibling .json file if present.
  const jsonPath = htmlPath.replace(/\.html$/, ".json");
  let meta: TemplateMetadata = {};
  if (existsSync(jsonPath)) {
    const raw = JSON.parse(readFileSync(jsonPath, "utf-8"));
    meta = {
      name: raw.attributes?.name || raw.name,
      subject: raw.attributes?.name || raw.name,
      created: raw.attributes?.created,
      editorType: raw.attributes?.editor_type,
    };
  }
  // Fall back to the filename for the template name.
  if (!meta.name) {
    meta.name = htmlPath.split("/").pop()?.replace(".html", "");
  }

  const result = await exportTemplateFromHtml(html, meta, opts);

  const outPath = htmlPath.replace(/\.html$/, ".redo-template.json");
  writeFileSync(outPath, JSON.stringify(result.template, null, 2));

  const { template: _t, ...rest } = result;
  return { outPath, ...rest };
}

/**
 * Walk top-level sections (and any nested column cells) to detect whether
 * any block references Redo's `checkoutUrl` schema field. Used to decide
 * whether this template should be emitted as `marketing_checkout_abandonment`.
 */
function referencesCheckoutUrl(sections: unknown[]): boolean {
  for (const section of sections) {
    if (!section || typeof section !== "object") continue;
    const s = section as {
      clickthroughSchemaFieldName?: string;
      schemaFieldName?: string;
      columns?: unknown[];
    };
    if (
      s.clickthroughSchemaFieldName === "checkoutUrl" ||
      s.schemaFieldName === "checkoutUrl"
    ) {
      return true;
    }
    if (Array.isArray(s.columns) && referencesCheckoutUrl(s.columns)) {
      return true;
    }
  }
  return false;
}

function printResult(r: ExportResult, verbose: boolean) {
  console.log(`  Name: ${r.name}`);
  console.log(`  Sections: ${r.sectionCount}`);
  if (r.substitutions.length > 0) {
    console.log(`  Substitutions: ${r.substitutions.length}`);
    if (verbose) for (const s of r.substitutions) console.log(`    - ${s}`);
  }
  if (r.aiRewrites > 0) {
    console.log(`  AI rewrites: ${r.aiRewrites} (in:${r.aiUsage.inputTokens} out:${r.aiUsage.outputTokens} cache-r:${r.aiUsage.cacheReadTokens})`);
  }
  if (r.warnings.length > 0) {
    console.log(`  Warnings: ${r.warnings.length}`);
    if (verbose) for (const w of r.warnings) console.log(`    - ${w}`);
  }
  if (r.unsupportedFeatures.length > 0) {
    console.log(`  Unsupported: ${r.unsupportedFeatures.length}`);
    if (verbose) for (const u of r.unsupportedFeatures) console.log(`    - [${u.blockType}] ${u.reason}`);
  }
  if (r.reviewItems.length > 0) {
    console.log(`  Review items: ${r.reviewItems.length}`);
    if (verbose) for (const ri of r.reviewItems) console.log(`    - [${ri.blockType}] ${ri.variableName}`);
  }
  if (r.skippedBlocks.length > 0) {
    console.log(`  Skipped: ${r.skippedBlocks.length}`);
    if (verbose) for (const s of r.skippedBlocks) console.log(`    - [${s.blockType}] ${s.reason}`);
  }
  if (r.fontPlan.entries.length > 0) {
    const unresolved = r.fontPlan.entries.filter((e) => !e.resolution.available);
    console.log(`  Fonts: ${r.fontPlan.entries.length}${unresolved.length > 0 ? ` (${unresolved.length} UNRESOLVED)` : ""}`);
  }
}

async function main() {
  const htmlPath = process.argv[2];

  if (!htmlPath) {
    console.error(
      "Usage: KLAVIYO_API_KEY=pk_... npx tsx src/export-template.ts <template.html>",
    );
    process.exit(1);
  }

  const apiKey = process.env.KLAVIYO_API_KEY;
  const skipAi =
    process.env.SKIP_AI === "1" ||
    !(process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY);

  if (!apiKey) console.warn("  Warning: KLAVIYO_API_KEY not set. Skipping variable substitution.");
  if (skipAi) console.warn("  Warning: AI skipped (SKIP_AI=1 or no Anthropic key).");

  let account = null;
  if (apiKey) {
    try {
      account = await fetchAccount(apiKey);
    } catch (e: any) {
      console.warn(`  Warning: fetchAccount failed (${e.message}). Skipping substitution.`);
    }
  }

  const result = await exportTemplate(htmlPath, { account, skipAi });
  console.log(`Exported: ${result.outPath}`);
  printResult(result, true);

  const typeCounts: Record<string, number> = {};
  // section types aren't on ExportResult directly — re-read the json
  const written = JSON.parse(readFileSync(result.outPath, "utf-8"));
  for (const s of written.sections ?? []) {
    typeCounts[s.type] = (typeCounts[s.type] || 0) + 1;
  }
  console.log("\n  Section breakdown:");
  for (const [type, count] of Object.entries(typeCounts)) {
    console.log(`    ${type}: ${count}`);
  }
}

// Only run CLI when invoked directly, not when imported as a module
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

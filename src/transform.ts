/**
 * Post-parse transformation pass: substitutes Klaviyo template variables
 * with Redo equivalents or literal values from the merchant's Klaviyo account.
 *
 * Runs on Section[] between parsing and export. Parser stays deterministic
 * (no API calls); all substitution lives here.
 */

import type { KlaviyoAccount } from "./fetch-account.js";
import { formatAddress } from "./fetch-account.js";
import type { Section } from "./renderer/types.js";

export interface TransformResult {
  sections: Section[];
  substitutions: string[];
}

export function transformSections(
  sections: Section[],
  account: KlaviyoAccount,
): TransformResult {
  const subs: string[] = [];
  const orgName = account.organizationName;
  const orgAddress = formatAddress(account);
  const orgUrl = account.websiteUrl;

  const transformed = sections.map((s) => transformBlock(s, orgName, orgAddress, orgUrl, subs));
  return { sections: transformed as Section[], substitutions: subs };
}

function transformBlock(
  block: Record<string, any>,
  orgName: string,
  orgAddress: string,
  orgUrl: string,
  subs: string[],
): Record<string, any> {
  const out = { ...block };

  // Text blocks: substitute variables in HTML
  if (out.type === "text" && typeof out.text === "string") {
    out.text = substituteTextVars(out.text, orgName, orgAddress, orgUrl, subs);
  }

  // Button blocks: substitute {{ organization.url }} in link
  if (out.type === "button" && typeof out.buttonLink === "string") {
    const newLink = substituteOrgUrl(out.buttonLink, orgUrl);
    if (newLink !== out.buttonLink) {
      subs.push(`button link: {{ organization.url }} → ${orgUrl}`);
      out.buttonLink = newLink;
    }
  }

  // Column blocks: recurse into children
  if (out.type === "column" && Array.isArray(out.columns)) {
    out.columns = out.columns.map((col: any) =>
      col ? transformBlock(col, orgName, orgAddress, orgUrl, subs) : null,
    );
  }

  return out;
}

// ─── Text variable substitution ──────────────────────────────────

function substituteTextVars(
  html: string,
  orgName: string,
  orgAddress: string,
  orgUrl: string,
  subs: string[],
): string {
  let result = html;

  // 1. {% unsubscribe %} — two patterns:
  //    a) wrapped in <a>: <a ...>{% unsubscribe %}</a> → <a href="{{ unsubscribe_link }}">original text before tag</a>
  //    b) bare: {% unsubscribe %} → <a href="{{ unsubscribe_link }}">Unsubscribe</a>

  // Pattern A: <a ...>...{% unsubscribe %}...</a> — replace href and keep inner text
  const wrappedUnsub = /<a\s[^>]*>([^<]*\{%\s*unsubscribe\s*%\}[^<]*)<\/a>/gi;
  if (wrappedUnsub.test(result)) {
    result = result.replace(
      /<a\s[^>]*>([^<]*)\{%\s*unsubscribe\s*%\}([^<]*)<\/a>/gi,
      (_match, before: string, after: string) => {
        const text = (before + after).trim() || "Unsubscribe";
        return `<a href="{{ unsubscribe_link }}">${text}</a>`;
      },
    );
    subs.push("{% unsubscribe %} → {{ unsubscribe_link }}");
  }

  // Pattern B: bare {% unsubscribe %} (not inside an <a>)
  if (/\{%\s*unsubscribe\s*%\}/.test(result)) {
    result = result.replace(
      /\{%\s*unsubscribe\s*%\}/g,
      `<a href="{{ unsubscribe_link }}">Unsubscribe</a>`,
    );
    subs.push("{% unsubscribe %} (bare) → {{ unsubscribe_link }}");
  }

  // 2. {{ organization.name }}
  if (/\{\{\s*organization\.name\s*\}\}/.test(result)) {
    result = result.replace(/\{\{\s*organization\.name\s*\}\}/g, orgName);
    subs.push(`{{ organization.name }} → ${orgName}`);
  }

  // 3. {{ organization.full_address }}
  if (/\{\{\s*organization\.full_address\s*\}\}/.test(result)) {
    result = result.replace(/\{\{\s*organization\.full_address\s*\}\}/g, orgAddress);
    subs.push(`{{ organization.full_address }} → ${orgAddress}`);
  }

  // 4. {{ organization.url }} in text hrefs
  result = substituteOrgUrlInHtml(result, orgUrl, subs);

  return result;
}

/** Replace {{ organization.url }} in href attributes within HTML */
function substituteOrgUrlInHtml(html: string, orgUrl: string, subs: string[]): string {
  const pattern = /href="(\{\{\s*organization\.url\s*\}\})"/gi;
  if (pattern.test(html)) {
    subs.push(`{{ organization.url }} (in href) → ${orgUrl}`);
    return html.replace(/href="\{\{\s*organization\.url\s*\}\}"/gi, `href="${orgUrl}"`);
  }
  return html;
}

/** Replace {{ organization.url }} in a raw URL string (e.g. buttonLink) */
function substituteOrgUrl(url: string, orgUrl: string): string {
  return url.replace(/^\s*\{\{\s*organization\.url\s*\}\}\s*$/, orgUrl);
}

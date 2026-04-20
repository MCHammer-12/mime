/**
 * HTTP-based importer — POSTs exported templates to Redo's marketing-rpc
 * endpoints. Used when mime runs on Replit (or anywhere without bazel /
 * direct redoapp + MongoDB access).
 *
 * Auth: merchant JWT. Sent as raw `Authorization: <jwt>` (no Bearer prefix).
 * In a browser this lives at localStorage key `redo.merchant_auth_token.<teamId>`.
 *
 * Wire format (per redoapp/rpc/src/server.ts):
 *   request:  { "input": <payload> }
 *   response: { "output": <value> } or { "error": "...", "code": ... }
 *
 * Endpoints:
 *   POST /marketing-rpc/createProductFilter  → { productFilterId }
 *   POST /marketing-rpc/createEmailTemplate  → <full EmailTemplate with _id>
 *
 * Team is determined by the JWT's `aud` claim — any `team` field on the
 * template body is ignored and overwritten server-side.
 */

import type { KlaviyoAccount } from "../fetch-account.js";

export const DEFAULT_MARKETING_RPC_BASE = "https://app-server.getredo.com/marketing-rpc";

export type ImportProgressEvent =
  | { kind: "filter_created"; templateName: string; productFilterId: string }
  | { kind: "template_created"; templateName: string; templateId: string }
  | { kind: "template_failed"; templateName: string; error: string };

export interface ImportOptions {
  jwt: string;
  baseUrl?: string;
  account?: KlaviyoAccount | null;
  onProgress?: (event: ImportProgressEvent) => void;
}

export interface ImportResult {
  templateId: string;
  name: string;
}

export async function importTemplateRpc(
  template: Record<string, any>,
  options: ImportOptions,
): Promise<ImportResult> {
  const prepared = await preparePayload(template, options);
  let created: any;
  try {
    created = await postRpc("createEmailTemplate", prepared, options);
  } catch (e: any) {
    options.onProgress?.({
      kind: "template_failed",
      templateName: template.name ?? "(unnamed)",
      error: e.message ?? String(e),
    });
    throw e;
  }
  const result: ImportResult = {
    templateId: String(created._id ?? created.id ?? ""),
    name: String(created.name ?? template.name ?? ""),
  };
  options.onProgress?.({
    kind: "template_created",
    templateName: result.name,
    templateId: result.templateId,
  });
  return result;
}

/** Strip non-prod fields + resolve per-block `_pendingFilter` into real filter IDs. */
async function preparePayload(
  template: Record<string, any>,
  options: ImportOptions,
): Promise<Record<string, any>> {
  // Drop non-prod / server-generated fields
  const {
    _id: _discardId,
    _fontPlan: _discardFontPlan,
    team: _discardTeam, // server sets from JWT
    createdAt: _discardCreatedAt, // server generates
    updatedAt: _discardUpdatedAt,
    ...rest
  } = template;

  // Resolve placeholder address if caller passed a Klaviyo account.
  if (options.account && looksLikePlaceholder(rest.address)) {
    rest.address = mapAccountAddress(options.account);
  }

  // Walk blocks; any with _pendingFilter → createProductFilter → swap ID.
  const sections = Array.isArray(rest.sections) ? rest.sections : [];
  rest.sections = [];
  for (const section of sections) {
    const blocks = Array.isArray(section.blocks) ? section.blocks : [];
    const resolvedBlocks: any[] = [];
    for (const block of blocks) {
      if (block && block._pendingFilter) {
        const productFilterId = await postRpc(
          "createProductFilter",
          block._pendingFilter,
          options,
        );
        options.onProgress?.({
          kind: "filter_created",
          templateName: String(template.name ?? ""),
          productFilterId: productFilterId.productFilterId ?? String(productFilterId),
        });
        const { _pendingFilter: _drop, ...blockRest } = block;
        resolvedBlocks.push({
          ...blockRest,
          recommendedProductFilterId:
            productFilterId.productFilterId ?? String(productFilterId),
        });
      } else {
        resolvedBlocks.push(block);
      }
    }
    rest.sections.push({ ...section, blocks: resolvedBlocks });
  }

  return rest;
}

async function postRpc(
  method: string,
  input: unknown,
  options: ImportOptions,
): Promise<any> {
  const base = options.baseUrl ?? DEFAULT_MARKETING_RPC_BASE;
  const url = `${base.replace(/\/$/, "")}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: options.jwt,
    },
    body: JSON.stringify({ input }),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON error body
  }
  if (!res.ok) {
    const msg = body?.error ?? body?.message ?? text?.slice(0, 200) ?? res.statusText;
    throw new Error(`${method} ${res.status}: ${msg}`);
  }
  if (body?.error) {
    throw new Error(`${method}: ${body.error}`);
  }
  return body?.output ?? body;
}

function looksLikePlaceholder(addr: any): boolean {
  if (!addr) return true;
  return (
    addr.businessAddress === "Business Name" ||
    addr.legalAddress === "123 Main St" ||
    addr.cityStateZip === "City, ST 12345"
  );
}

function mapAccountAddress(account: KlaviyoAccount) {
  const a = account.address;
  const cityStateZip = [a.city, a.region].filter(Boolean).join(", ") +
    (a.zip ? ` ${a.zip}` : "");
  return {
    businessAddress: account.organizationName || "",
    legalAddress: a.street || "",
    cityStateZip: cityStateZip.trim(),
    country: a.country || "",
  };
}

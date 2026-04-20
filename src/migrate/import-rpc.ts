/**
 * HTTP-based importer — runs the mime → Redo import pipeline against Redo's
 * marketing-rpc / general-rpc / team endpoints. Used when mime runs on Replit
 * (or anywhere without bazel / direct redoapp + MongoDB access).
 *
 * Auth: merchant JWT. Sent as raw `Authorization: <jwt>` (no Bearer prefix).
 * In a browser this lives at localStorage key `redo.merchant_auth_token.<teamId>`.
 *
 * Wire format (from @redotech/rpc):
 *   request:  { "input": <payload> }
 *   response: { "output": <value> } or { "error": "...", "code": ... }
 *
 * Endpoints used:
 *   POST /marketing-rpc/createProductFilter  → { productFilterId }
 *   POST /marketing-rpc/createEmailTemplate  → <full EmailTemplate with _id>
 *   POST /rpc/processFontFiles               → { fontFamilies: CustomFontFamily[] }
 *   POST /rpc/updateBrandKit                 → { success: true }
 *   GET  /team                               → <Team doc>
 *   POST /team/upload-attachment             → { url, fileSize, fileName } (multipart)
 *
 * Team is determined by the JWT's `aud` claim — any `team` field on the
 * template body is ignored and overwritten server-side. `updateBrandKit`
 * overwrites the entire brand kit, so font upload MUST fetch the current
 * team first and merge into `settings.brandKit.customFontFamilies`.
 */

import type { KlaviyoAccount } from "../fetch-account.js";
import type { FontPlan, FontPlanEntry, FontFileSpec } from "../fonts.js";

export const DEFAULT_SERVER_BASE = "https://app-server.getredo.com";

export type ImportProgressEvent =
  | { kind: "filter_created"; templateName: string; productFilterId: string }
  | { kind: "template_created"; templateName: string; templateId: string }
  | { kind: "template_failed"; templateName: string; error: string }
  | { kind: "font_uploading"; family: string; fileName: string }
  | { kind: "font_registered"; family: string }
  | { kind: "fonts_done"; uploaded: number; skipped: number };

export interface ImportOptions {
  jwt: string;
  /** Root of the Redo server, e.g. "https://app-server.getredo.com". */
  serverBase?: string;
  account?: KlaviyoAccount | null;
  onProgress?: (event: ImportProgressEvent) => void;
}

export interface ImportResult {
  templateId: string;
  name: string;
}

// ─── Template import ───────────────────────────────────────────────────────

export async function importTemplateRpc(
  template: Record<string, any>,
  options: ImportOptions,
): Promise<ImportResult> {
  const prepared = await preparePayload(template, options);
  let created: any;
  try {
    created = await postMarketingRpc("createEmailTemplate", prepared, options);
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
  const {
    _id: _discardId,
    _fontPlan: _discardFontPlan,
    team: _discardTeam, // server sets from JWT
    createdAt: _discardCreatedAt, // server generates
    updatedAt: _discardUpdatedAt,
    ...rest
  } = template;

  if (options.account && looksLikePlaceholder(rest.address)) {
    rest.address = mapAccountAddress(options.account);
  }

  const sections = Array.isArray(rest.sections) ? rest.sections : [];
  rest.sections = [];
  for (const section of sections) {
    const blocks = Array.isArray(section.blocks) ? section.blocks : [];
    const resolvedBlocks: any[] = [];
    for (const block of blocks) {
      if (block && block._pendingFilter) {
        const filterRes = await postMarketingRpc(
          "createProductFilter",
          block._pendingFilter,
          options,
        );
        const productFilterId = filterRes.productFilterId ?? String(filterRes);
        options.onProgress?.({
          kind: "filter_created",
          templateName: String(template.name ?? ""),
          productFilterId,
        });
        const { _pendingFilter: _drop, ...blockRest } = block;
        resolvedBlocks.push({
          ...blockRest,
          recommendedProductFilterId: productFilterId,
        });
      } else {
        resolvedBlocks.push(block);
      }
    }
    rest.sections.push({ ...section, blocks: resolvedBlocks });
  }

  return rest;
}

// ─── Font upload ───────────────────────────────────────────────────────────

export interface FontUploadResult {
  uploaded: number; // file count (not family count)
  registeredFamilies: number;
  skipped: number; // files skipped because family was already in brand kit
  unresolved: Array<{ family: string; reason: string; usedBy: string[] }>;
}

/**
 * Upload all resolved fonts referenced by the batch's templates to the target
 * merchant's brand kit. Idempotent by family name — we fetch the current
 * brand kit and merge (skipping families that already exist).
 *
 * Unresolved fonts are NOT an error — they're returned in the result so the
 * caller can decide whether to block or warn. (The bazel importer hard-fails;
 * this function defers that decision upward so the server can produce a more
 * informative per-template report.)
 */
export async function uploadFontsForTemplates(
  templates: Array<{ name?: string; _fontPlan?: FontPlan }>,
  options: ImportOptions,
): Promise<FontUploadResult> {
  const unionByFamily = new Map<string, FontPlanEntry>();
  for (const tmpl of templates) {
    const plan = tmpl._fontPlan;
    if (!plan) continue;
    for (const entry of plan.entries) {
      if (!unionByFamily.has(entry.family)) unionByFamily.set(entry.family, entry);
    }
  }

  const unresolved = [...unionByFamily.values()]
    .filter((e) => !e.resolution.available)
    .map((e) => ({
      family: e.family,
      reason: e.resolution.available ? "" : e.resolution.reason,
      usedBy: e.usedBy,
    }));

  const resolved = [...unionByFamily.values()].filter(
    (e) => e.resolution.available,
  );

  if (resolved.length === 0) {
    const result = { uploaded: 0, registeredFamilies: 0, skipped: 0, unresolved };
    options.onProgress?.({ kind: "fonts_done", uploaded: 0, skipped: 0 });
    return result;
  }

  // 1. Fetch current brand kit so we can merge (updateBrandKit overwrites).
  const team = await getTeam(options);
  const currentBrandKit: any = team?.settings?.brandKit ?? {};
  const currentFamilies: any[] = Array.isArray(currentBrandKit.customFontFamilies)
    ? currentBrandKit.customFontFamilies
    : [];
  const existingFamilyNames = new Set(
    currentFamilies.map((f) => String(f.fontFamily ?? "").toLowerCase()),
  );

  // 2. For each resolved family NOT already in the brand kit, upload each
  //    weight file + record {url, name}. Families already present are skipped
  //    (we don't re-upload to avoid duplicates in the team's file store).
  let uploadedFiles = 0;
  let skippedFamilies = 0;
  const uploads: Array<{ url: string; name: string; family: string; fallback: string }> = [];

  for (const entry of resolved) {
    if (existingFamilyNames.has(entry.family.toLowerCase())) {
      skippedFamilies++;
      continue;
    }
    const files = entry.resolution.available ? entry.resolution.files : [];
    for (const file of files) {
      const fileName = synthesizeFontFileName(entry.family, file);
      options.onProgress?.({
        kind: "font_uploading",
        family: entry.family,
        fileName,
      });
      const bytes = await downloadFontBytes(file.url);
      const uploadedUrl = await uploadAttachment(bytes, fileName, options);
      uploadedFiles++;
      uploads.push({
        url: uploadedUrl,
        name: fileName,
        family: entry.family,
        fallback: entry.fallback,
      });
    }
  }

  if (uploads.length === 0) {
    const result = {
      uploaded: 0,
      registeredFamilies: 0,
      skipped: skippedFamilies,
      unresolved,
    };
    options.onProgress?.({ kind: "fonts_done", uploaded: 0, skipped: skippedFamilies });
    return result;
  }

  // 3. processFontFiles extracts family/weight/italic from the uploaded files
  //    and returns grouped CustomFontFamily[].
  const processed = await postRpc(
    "processFontFiles",
    { fontUrls: uploads.map((u) => ({ url: u.url, name: u.name })) },
    options,
  );
  const newFamilies: any[] = Array.isArray(processed?.fontFamilies)
    ? processed.fontFamilies
    : [];

  // Server may pick a different fallback than we'd prefer; if entry.fallback is
  // set and the returned family's fallback is "sans-serif" (default), override.
  for (const fam of newFamilies) {
    const localEntry = uploads.find(
      (u) => u.family.toLowerCase() === String(fam.fontFamily ?? "").toLowerCase(),
    );
    if (localEntry?.fallback) fam.fallbackFont = localEntry.fallback;
    options.onProgress?.({ kind: "font_registered", family: String(fam.fontFamily ?? "") });
  }

  // 4. Merge into the existing brand kit and push it back whole.
  const mergedBrandKit = {
    ...currentBrandKit,
    customFontFamilies: [...currentFamilies, ...newFamilies],
  };

  await postRpc("updateBrandKit", { brandKit: mergedBrandKit }, options);

  options.onProgress?.({
    kind: "fonts_done",
    uploaded: uploadedFiles,
    skipped: skippedFamilies,
  });

  return {
    uploaded: uploadedFiles,
    registeredFamilies: newFamilies.length,
    skipped: skippedFamilies,
    unresolved,
  };
}

function synthesizeFontFileName(family: string, file: FontFileSpec): string {
  const slug = family.replace(/\s+/g, "");
  const italic = file.italic ? "-italic" : "";
  return `${slug}-${file.weight}${italic}.woff2`;
}

async function downloadFontBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download font ${url}: ${res.status} ${res.statusText}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function uploadAttachment(
  bytes: Uint8Array,
  fileName: string,
  options: ImportOptions,
): Promise<string> {
  const base = options.serverBase ?? DEFAULT_SERVER_BASE;
  const form = new FormData();
  form.append("attachment", new Blob([bytes as BlobPart]), fileName);
  const res = await fetch(`${base}/team/upload-attachment`, {
    method: "POST",
    headers: { authorization: options.jwt },
    body: form,
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
    throw new Error(`upload-attachment ${res.status}: ${msg}`);
  }
  const url = body?.url;
  if (typeof url !== "string" || !url) {
    throw new Error(`upload-attachment: missing url in response`);
  }
  return url;
}

async function getTeam(options: ImportOptions): Promise<any> {
  const base = options.serverBase ?? DEFAULT_SERVER_BASE;
  const res = await fetch(`${base}/team`, {
    method: "GET",
    headers: { authorization: options.jwt },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`get team ${res.status}: ${text?.slice(0, 200) ?? res.statusText}`);
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`get team: non-JSON response`);
  }
}

// ─── RPC wire helpers ──────────────────────────────────────────────────────

async function postMarketingRpc(
  method: string,
  input: unknown,
  options: ImportOptions,
): Promise<any> {
  return postAtPath(`/marketing-rpc/${method}`, input, options);
}

async function postRpc(
  method: string,
  input: unknown,
  options: ImportOptions,
): Promise<any> {
  return postAtPath(`/rpc/${method}`, input, options);
}

async function postAtPath(
  path: string,
  input: unknown,
  options: ImportOptions,
): Promise<any> {
  const base = options.serverBase ?? DEFAULT_SERVER_BASE;
  const url = `${base.replace(/\/$/, "")}${path}`;
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
    throw new Error(`POST ${path} ${res.status}: ${msg}`);
  }
  if (body?.error) {
    throw new Error(`POST ${path}: ${body.error}`);
  }
  return body?.output ?? body;
}

// ─── address helpers ───────────────────────────────────────────────────────

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

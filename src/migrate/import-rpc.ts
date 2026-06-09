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

// Minimum-viable brand kit used as the base when a merchant's existing kit
// is missing any of the five required sibling objects
// (colors / font / inputs / buttons / images). Mirrors
// redoapp/redo/model/src/brand-kit.ts → defaultBrandKit so updateBrandKit's
// Zod validator accepts the payload. Team customizations spread on top.
const DEFAULT_BRAND_KIT = {
  colors: { background: "#ffffff", accent: "#000000" },
  font: {
    fontFamily: "Arial",
    headerFontFamily: "Arial",
    bodyFontFamily: "Arial",
    hierarchy: {
      h1: { fontSizePx: 48, fontWeight: "bold" },
      h2: { fontSizePx: 36, fontWeight: "semibold" },
      h3: { fontSizePx: 30, fontWeight: "regular" },
      body: { fontSizePx: 16, fontWeight: "regular" },
      subtext: { fontSizePx: 14, fontWeight: "regular" },
    },
  },
  inputs: {
    backgroundColor: "#ffffff",
    errorColor: "#ff0000",
    textColor: "#000000",
    border: { cornerRadiusPx: 8, stroke: { color: "#000000", weightPx: 1 } },
    paddingPx: 8,
    fontReference: "body",
  },
  buttons: {
    primary: {
      backgroundColor: "#000000",
      textColor: "#ffffff",
      border: { cornerRadiusPx: 8, stroke: { color: "#000000", weightPx: 1 } },
      paddingPx: 8,
      fontReference: "body",
    },
    secondary: {
      backgroundColor: "#ffffff",
      textColor: "#000000",
      border: { cornerRadiusPx: 8, stroke: { color: "#000000", weightPx: 1 } },
      paddingPx: 8,
      fontReference: "body",
    },
    tertiary: {
      backgroundColor: undefined,
      textColor: "#000000",
      border: { cornerRadiusPx: 8, stroke: { color: "#000000", weightPx: 0 } },
      paddingPx: 8,
      fontReference: "body",
    },
  },
  images: { logoUrl: "", faviconUrl: "", bannerUrl: "", logoBannerUrl: "" },
};

/**
 * Thrown when Redo returns 401/403 on an authenticated RPC call —
 * almost always means the merchant JWT has expired (they last ~a few
 * days). Callers can catch this specifically to prompt the user for a
 * fresh token and retry, instead of failing the whole job with a
 * generic "POST /foo 401" message.
 */
export class RedoAuthExpiredError extends Error {
  readonly code = "redo_auth_expired" as const;
  readonly status: number;
  readonly endpoint: string;
  constructor(endpoint: string, status: number, detail?: string) {
    super(
      `Redo auth expired (${status} on ${endpoint})` +
        (detail ? `: ${detail}` : ""),
    );
    this.name = "RedoAuthExpiredError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

/** Normalize a server base URL — trim trailing slashes so callers can't
 *  accidentally produce `//team` by pasting a URL with a trailing slash. */
function resolveServerBase(serverBase: string | undefined | null): string {
  const raw = (serverBase ?? DEFAULT_SERVER_BASE).trim();
  return raw.replace(/\/+$/, "") || DEFAULT_SERVER_BASE;
}

/** Decode a Redo merchant JWT's `aud` claim — the team ID. Returns null
 *  for non-JWTs (e.g. `redo_pat_…` personal access tokens) or malformed
 *  tokens. Matches the priority order used by the credentials editor:
 *  `aud` ?? `teamId` ?? `team_id` ?? `sub` (see ui/mock-stores.js). */
export function decodeJwtAud(jwt: string | null | undefined): string | null {
  if (!jwt) return null;
  const t = jwt.trim();
  if (t.startsWith("redo_pat_")) return null;
  const parts = t.split(".");
  if (parts.length !== 3) return null;
  try {
    let s = parts[1];
    const pad = s.length % 4;
    if (pad === 2) s += "==";
    else if (pad === 3) s += "=";
    else if (pad === 1) return null;
    const norm = s.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(norm, "base64").toString("utf8");
    const payload = JSON.parse(json);
    const v = payload.aud ?? payload.teamId ?? payload.team_id ?? payload.sub;
    return typeof v === "string" && v.length ? v : null;
  } catch {
    return null;
  }
}

export type ImportProgressEvent =
  | { kind: "filter_created"; templateName: string; productFilterId: string }
  | { kind: "template_created"; templateName: string; templateId: string }
  | { kind: "template_failed"; templateName: string; error: string }
  | { kind: "font_uploading"; family: string; fileName: string }
  | { kind: "font_registered"; family: string }
  | { kind: "fonts_done"; uploaded: number; skipped: number }
  | { kind: "flow_started"; flowName: string; placeholderCount: number }
  | { kind: "flow_created"; flowName: string; flowId: string }
  | { kind: "flow_failed"; flowName: string; error: string };

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

export interface ImportTemplateOptions extends ImportOptions {
  /**
   * When true, write the template into Redo's SavedEmailTemplate collection
   * (it shows up in the "Saved templates" library tab). When false (default),
   * write into EmailTemplate (shows up in "Previous emails").
   *
   * Use `true` for standalone template imports + campaign imports — the
   * merchant browses these as a library. Use `false` (default) for flow-
   * attached template placeholders — flow steps reference EmailTemplate `_id`s
   * by value, and a SavedEmailTemplate isn't a valid reference target.
   *
   * Source: redoapp `redo/marketing/db/util/src/saved-email-template-repo.ts`
   * + `redo/merchant/marketing/rpc/src/schema/saved-templates/...`.
   */
  asSavedTemplate?: boolean;
}

export async function importTemplateRpc(
  template: Record<string, any>,
  options: ImportTemplateOptions,
): Promise<ImportResult> {
  const prepared = await preparePayload(template, options);
  let created: any;
  try {
    if (options.asSavedTemplate) {
      // Wrap the EmailTemplate inside a SavedEmailTemplate envelope. The
      // saved-template handler embeds the `template` payload as-is, then
      // adds `templateName`, `source`, `team`, `lastUsed` etc. on the
      // outer doc. Source = "saved" places it in the library tab; the
      // other source values ("forwarded", "uploaded") are filtered out.
      //
      // Inject `team` on the embedded template: redoapp's Mongoose schema
      // (`emailTemplateSchemaDefinition.team` in
      // redo/marketing/db/schema/src/EmailTemplate.ts) marks it required,
      // and unlike createEmailTemplate, the createSavedEmailTemplate handler
      // does NOT inject team from the JWT context onto the embedded doc
      // (only on the outer wrapper). Without this, Mongoose throws a
      // validation error → 500.
      const teamFromJwt = decodeJwtAud(options.jwt);
      const embedded = teamFromJwt ? { ...prepared, team: teamFromJwt } : prepared;
      created = await postMarketingRpc(
        "createSavedEmailTemplate",
        {
          template: embedded,
          name: String(embedded.name ?? template.name ?? "Imported Template"),
          source: "saved",
        },
        options,
      );
    } else {
      created = await postMarketingRpc("createEmailTemplate", prepared, options);
    }
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
    _fontPlan: _discardFontPlan,
    team: _discardTeam, // server sets from JWT
    createdAt: _discardCreatedAt, // server generates
    updatedAt: _discardUpdatedAt,
    ...rest
  } = template;
  // Keep `_id`: createSavedEmailTemplate's input is `template: emailTemplateSchema`
  // (full schema, `_id` required as a valid ObjectId). createEmailTemplate's
  // input is `emailTemplateSchema.omit({_id: true})`, so an `_id` passed there
  // is silently stripped by Zod and the server still generates its own.

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
 * Fetch the merchant's brand kit and return which unresolved-font entries
 * are STILL missing — i.e. not already registered as a custom font family
 * on the team. Used by the server's preflight gate so we only prompt the
 * user for fonts they actually need to add.
 */
export async function filterFontsNotInBrandKit(
  unresolved: Array<{ family: string; reason: string; usedBy: string[] }>,
  options: ImportOptions,
): Promise<Array<{ family: string; reason: string; usedBy: string[] }>> {
  if (unresolved.length === 0) return [];
  const teamResponse = await getTeam(options);
  const teamDoc: any = teamResponse?.team ?? teamResponse ?? {};
  const currentFamilies: any[] = Array.isArray(
    teamDoc?.settings?.brandKit?.customFontFamilies,
  )
    ? teamDoc.settings.brandKit.customFontFamilies
    : [];
  const existing = new Set(
    currentFamilies.map((f: any) => String(f.fontFamily ?? "").toLowerCase()),
  );
  return unresolved.filter((u) => !existing.has(u.family.toLowerCase()));
}

/**
 * Return the team's brand-kit custom font family NAMES (e.g.
 * ["Futura PT", "Poppins SemiBold"]). Used by the preflight to fuzzy-match
 * a still-missing Klaviyo font against fonts the operator just added under
 * a different name. Empty array on any fetch issue (caller degrades to
 * "no auto-match, prompt for all").
 */
export async function getBrandKitFontFamilies(
  options: ImportOptions,
): Promise<string[]> {
  const teamResponse = await getTeam(options);
  const teamDoc: any = teamResponse?.team ?? teamResponse ?? {};
  const families: any[] = Array.isArray(
    teamDoc?.settings?.brandKit?.customFontFamilies,
  )
    ? teamDoc.settings.brandKit.customFontFamilies
    : [];
  return families
    .map((f: any) => String(f.fontFamily ?? "").trim())
    .filter((s: string) => s.length > 0);
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
  //    /team returns `{_id: <user/membership id>, team: {_id: <team id>, ...}}`,
  //    so settings.brandKit lives on `.team.settings.brandKit`, NOT top-level.
  //    (Same wrapper bug as PR #14.) Fall back to the top-level shape in case
  //    a different endpoint or response format returns it flat.
  const teamResponse = await getTeam(options);
  const teamDoc: any = teamResponse?.team ?? teamResponse ?? {};
  const currentBrandKit: any = teamDoc?.settings?.brandKit ?? {};
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
  //    updateBrandKit's Zod validator requires colors/font/inputs/buttons/images
  //    as siblings (see redoapp redo/model/src/brand-kit.ts). Teams that never
  //    customized the kit may have no values — fall back to a default shape so
  //    the request validates. Team customizations override the default.
  const mergedBrandKit = {
    ...DEFAULT_BRAND_KIT,
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
  const base = resolveServerBase(options.serverBase);
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
    // Surface the full error body — redoapp's RPC wrapper sometimes returns
    // plain-text 500s with the real detail in the body. Truncated messages
    // used to hide the useful bits ("Internal server error" vs. the Zod
    // stack trace that follows it).
    const msg =
      body?.error ??
      body?.message ??
      (text && text.length > 0 ? text.slice(0, 2000) : res.statusText);
    // 401 = JWT expired / invalid → refreshable. 403 = authenticated but
    // lacks permission for this resource → no refresh fixes it; let the
    // caller see Redo's "Lacking required permissions" message and stop.
    if (res.status === 401) {
      throw new RedoAuthExpiredError("/team/upload-attachment", res.status, msg);
    }
    throw new Error(`upload-attachment ${res.status}: ${msg}`);
  }
  const url = body?.url;
  if (typeof url !== "string" || !url) {
    throw new Error(`upload-attachment: missing url in response`);
  }
  return url;
}

async function getTeam(options: ImportOptions): Promise<any> {
  const base = resolveServerBase(options.serverBase);
  const res = await fetch(`${base}/team`, {
    method: "GET",
    headers: { authorization: options.jwt },
  });
  const text = await res.text();
  if (!res.ok) {
    // Only 401 means refreshable JWT issue. 403 is a permission denial
    // that a token paste can't resolve.
    if (res.status === 401) {
      throw new RedoAuthExpiredError("/team", res.status, text?.slice(0, 500));
    }
    throw new Error(`get team ${res.status}: ${text?.slice(0, 2000) ?? res.statusText}`);
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
  const base = resolveServerBase(options.serverBase);
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
    // Surface the full error body — redoapp's RPC wrapper sometimes returns
    // plain-text 500s with the real detail in the body. Truncated messages
    // used to hide the useful bits ("Internal server error" vs. the Zod
    // stack trace that follows it).
    const msg =
      body?.error ??
      body?.message ??
      (text && text.length > 0 ? text.slice(0, 2000) : res.statusText);
    // 401 → JWT expired/invalid → refreshable via prompt. 403 → user is
    // authenticated but lacks the required permission for this RPC; no
    // amount of token-pasting fixes it. Let Redo's "Lacking required
    // permissions" message bubble up so the caller sees the real reason.
    if (res.status === 401) {
      throw new RedoAuthExpiredError(path, res.status, msg);
    }
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

// ─── Flow import ───────────────────────────────────────────────────────────

export interface FlowImportBundle {
  /** Output of src/flow/parser.ts → parseFlow(). */
  automation: {
    team?: string;
    name: string;
    description?: string;
    enabled: boolean;
    steps: Array<Record<string, any>>;
    schemaType: string;
    category: string;
    [k: string]: unknown;
  };
  warnings: Array<{ kind: string; message: string; actionId?: string }>;
  placeholderTemplates: Array<{
    sentinelId: string;
    klaviyoTemplateId: string | null;
    subject: string;
    fromEmail: string | null;
    fromLabel: string | null;
    previewText: string | null;
    fullTemplate: Record<string, any> | null;
    templateWarnings: string[];
  }>;
  /** Klaviyo `send-sms` actions converted to placeholder SmsTemplates.
   *  importFlowRpc creates each via createSmsTemplate then swaps the
   *  sentinel on the matching SendSmsStep with the real ObjectId. */
  placeholderSmsTemplates?: Array<{
    sentinelId: string;
    klaviyoActionId: string;
    name: string;
    content: string;
    schemaType: string;
    category: string;
    autoShortenLinks?: boolean;
    smsImageId?: string;
    templateWarnings: string[];
  }>;
}

export interface FlowImportResult {
  flowId: string;
  name: string;
  createdTemplateCount: number;
  blankTemplateCount: number;
}

/**
 * Full-automation import: for each placeholder in the bundle, create the
 * corresponding EmailTemplate (using the parsed `fullTemplate` if present,
 * otherwise a blank with just subject/preview metadata), swap the sentinels
 * in the automation's send_email steps, then POST the automation via
 * createAdvancedFlow. Team is derived from the JWT's `aud` claim.
 *
 * Does NOT handle font upload here — callers should invoke
 * `uploadFontsForTemplates()` once per batch (with the union of all
 * `placeholder.fullTemplate._fontPlan`s across the flows they're importing)
 * BEFORE calling this function so templates reference already-registered
 * custom fonts.
 */
export async function importFlowRpc(
  bundle: FlowImportBundle,
  options: ImportOptions,
): Promise<FlowImportResult> {
  options.onProgress?.({
    kind: "flow_started",
    flowName: bundle.automation.name,
    placeholderCount: bundle.placeholderTemplates.length,
  });

  // 1. Create EmailTemplates for every placeholder. Build a sentinel→real-id
  //    map to swap into the automation steps.
  const sentinelToRealId = new Map<string, string>();
  let createdTemplateCount = 0;
  let blankTemplateCount = 0;

  // The flow's trigger schemaType determines which dynamic variables the
  // email builder exposes (e.g. productName/productUrl on
  // marketing_back_in_stock, cartSubtotal on cart_abandonment). Templates
  // imported as part of a flow inherit it; exportTemplate's default
  // (`marketing_email`) is the right answer only for standalone templates.
  const flowSchemaType = bundle.automation.schemaType ?? "marketing_email";
  for (const ph of bundle.placeholderTemplates) {
    const templateJson = ph.fullTemplate
      ? {
          ...ph.fullTemplate,
          // Merge the Klaviyo send-email metadata over whatever the HTML
          // parser inferred (subject/name/preview are more accurate from
          // the action than from the template HTML).
          subject: ph.subject || ph.fullTemplate.subject || "",
          emailPreview: ph.previewText ?? ph.fullTemplate.emailPreview ?? null,
          name: `${bundle.automation.name} — ${ph.subject || ph.fullTemplate.name || "email"}`.slice(0, 200),
          schemaType: flowSchemaType,
        }
      : buildBlankTemplate(bundle.automation.name, ph, flowSchemaType);

    try {
      const created = await importTemplateRpc(templateJson, options);
      sentinelToRealId.set(ph.sentinelId, created.templateId);
      if (ph.fullTemplate) createdTemplateCount++;
      else blankTemplateCount++;
    } catch (e: any) {
      // Auth-expiry must NOT be swallowed by the blank-template fallback —
      // a 401 means every subsequent template create will fail with the
      // same error, and the caller (server.ts → withFreshJwt) needs the
      // typed error to prompt for a fresh JWT and retry the whole flow.
      if (e instanceof RedoAuthExpiredError) throw e;
      // Don't abort the whole flow on one template failure — we'll fall back
      // to a blank and let the merchant fix it in the UI. Progress event was
      // already emitted by importTemplateRpc on failure.
      try {
        const blank = await importTemplateRpc(
          buildBlankTemplate(bundle.automation.name, ph, flowSchemaType),
          options,
        );
        sentinelToRealId.set(ph.sentinelId, blank.templateId);
        blankTemplateCount++;
      } catch (e2: any) {
        // Same rule for the fallback path: surface auth expiry typed.
        if (e2 instanceof RedoAuthExpiredError) throw e2;
        // If even the blank fails (and it's not auth), we can't proceed.
        throw new Error(
          `Template creation failed for "${ph.subject}": ${e.message ?? e}`,
        );
      }
    }
  }

  // 1b. Same loop for SMS placeholders. createSmsTemplate is on /marketing-rpc
  //     and follows the same pattern as createEmailTemplate. Each placeholder
  //     becomes one SmsTemplate; sentinel → real id swap shares the email
  //     map so the step-rewrite step below handles both types uniformly.
  for (const ph of bundle.placeholderSmsTemplates ?? []) {
    const teamId = await resolveTeamId(options);
    const template: Record<string, any> = {
      team: teamId,
      name: `${bundle.automation.name} — ${ph.name}`.slice(0, 200),
      content: ph.content,
      templateType: "marketing",
      category: ph.category,
      schemaType: ph.schemaType,
    };
    // Always send through (including `false`) — Redo's mongoose default
    // is true, so omitting the field would land migrated SMS templates with
    // shortening on regardless of Klaviyo's setting.
    if (typeof ph.autoShortenLinks === "boolean") {
      template.autoShortenLinks = ph.autoShortenLinks;
    }

    try {
      const created = await postMarketingRpc(
        "createSmsTemplate",
        { template },
        options,
      );
      const realId = String(created._id ?? created.id ?? "");
      sentinelToRealId.set(ph.sentinelId, realId);
      options.onProgress?.({
        kind: "template_created",
        templateName: template.name,
        templateId: realId,
      });
    } catch (e: any) {
      if (e instanceof RedoAuthExpiredError) throw e;
      // SMS template create failed. Bubble the error up — unlike email we
      // don't have a "blank fallback" pattern, and the failed SMS would
      // leave the SendSmsStep with a sentinel templateId that the create-
      // advanced-flow RPC would reject. Better to fail the flow visibly.
      options.onProgress?.({
        kind: "template_failed",
        templateName: template.name,
        error: e.message ?? String(e),
      });
      throw e;
    }
  }

  // 2. Swap sentinel templateIds in the automation. Both send_email and
  //    send_sms steps use the same sentinel→real map.
  const steps = bundle.automation.steps.map((step) => {
    if (step.type !== "send_email" && step.type !== "send_sms") return step;
    const real = sentinelToRealId.get(String(step.templateId ?? ""));
    if (!real) return step; // leave as-is; server will reject, caller sees the error
    return { ...step, templateId: real };
  });

  // 3. Strip fields createAdvancedFlow doesn't accept, derive team from JWT.
  //    The schema omits _id, createdAt, updatedAt, versionGroupId server-side.
  const {
    team: _discardTeam, // server uses ctx.team from JWT
    versionGroupId: _discardVersionGroupId,
    ...flowRest
  } = bundle.automation;

  const newFlow = { ...flowRest, steps, team: await resolveTeamId(options) };

  let created: any;
  try {
    // createAdvancedFlow is mounted on the general /rpc router, NOT /marketing-rpc.
    // createEmailTemplate + createProductFilter are on /marketing-rpc, which is
    // why they worked above. Confirmed in redoapp/redo/merchant/server/src/index.ts:302.
    created = await postRpc(
      "createAdvancedFlow",
      { newFlow, setIndex: true },
      options,
    );
  } catch (e: any) {
    // Compact breadcrumb summarising the payload that failed. When prod
    // redoapp's RPC framework hides the real error behind a generic 500,
    // this at least gives us schemaType / category / team / per-type step
    // counts for offline triage. Full step JSON was useful during active
    // debugging — if you need it back, bisect the payload or apply
    // create-advanced-flow's describeError patch locally and tunnel in.
    const stepTypes: Record<string, number> = {};
    for (const s of newFlow.steps ?? []) {
      const t = String((s as any).type ?? "?");
      stepTypes[t] = (stepTypes[t] ?? 0) + 1;
    }
    options.onProgress?.({
      kind: "template_failed" as any,
      templateName: `[flow debug] ${bundle.automation.name}`,
      error:
        `schemaType=${(newFlow as any).schemaType} ` +
        `category=${(newFlow as any).category} ` +
        `team=${(newFlow as any).team} ` +
        `steps=${(newFlow.steps ?? []).length} (${JSON.stringify(stepTypes)})`,
    });
    options.onProgress?.({
      kind: "flow_failed",
      flowName: bundle.automation.name,
      error: e.message ?? String(e),
    });
    throw e;
  }
  const flowId = String(created.id ?? created._id ?? "");
  options.onProgress?.({
    kind: "flow_created",
    flowName: bundle.automation.name,
    flowId,
  });
  return {
    flowId,
    name: bundle.automation.name,
    createdTemplateCount,
    blankTemplateCount,
  };
}

function buildBlankTemplate(
  flowName: string,
  ph: FlowImportBundle["placeholderTemplates"][number],
  schemaType: string = "marketing_email",
): Record<string, any> {
  return {
    name: `[Placeholder] ${flowName} — ${ph.subject || ph.klaviyoTemplateId || "email"}`.slice(0, 200),
    subject: ph.subject || "",
    emailPreview: ph.previewText ?? null,
    templateType: "marketing",
    category: "Marketing",
    // Match the parent flow's trigger schemaType so the builder exposes
    // the right dynamic variables. See importFlowRpc note above.
    schemaType,
    sections: [],
    emailBackgroundColor: "#f7f7f7",
    contentBackgroundColor: "#ffffff",
    address: {
      businessAddress: "",
      legalAddress: "",
      cityStateZip: "",
      country: "",
    },
    linkColor: "#0000ee",
    isPlainText: false,
  };
}

// Cache: one /team call per ImportOptions.jwt.
const teamIdCache = new WeakMap<object, Promise<string>>();
async function resolveTeamId(options: ImportOptions): Promise<string> {
  // /team response shape: `{ _id: <user/membership id>, team: { _id: <team id>, ... } }`.
  // The top-level _id is the JWT `sub` (user/membership), NOT the team. The
  // team's _id — which is what createAdvancedFlow's team-mismatch check
  // compares against (ctx.team._id from JWT aud) — lives at `.team._id`.
  if (!teamIdCache.has(options)) {
    teamIdCache.set(
      options,
      getTeam(options).then((t) => {
        const id = t?.team?._id ?? t?.team?.id ?? t?._id ?? t?.id;
        if (!id) throw new Error("Could not resolve team ID from /team response");
        return String(id);
      }),
    );
  }
  return teamIdCache.get(options)!;
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KlaviyoAccount } from "../fetch-account.js";
import {
  exportTemplateFromHtml,
  type TemplateMetadata,
} from "../export-template.js";
import { klaviyo } from "../klaviyo.js";

interface TemplateManifest {
  merchant: string;
  templates: Array<{
    id: string;
    name?: string;
    editor_type?: string;
    updated?: string;
    created?: string;
    files?: { html?: string; json?: string };
  }>;
}

export interface ResolvedTemplate {
  /** Full Redo EmailTemplate JSON (includes `sections`, `_fontPlan`, `address`, ...). */
  template: Record<string, any>;
  /** Warnings from the template parser (kept separate from flow warnings). */
  warnings: string[];
}

/** Why a resolve() call returned null. Surfaced to the flow parser so each
 *  blank-fallback placeholder can carry a specific reason instead of the
 *  generic "not found in manifest" warning. */
export type ResolveFailureReason =
  | "manifest-miss-no-api-key"
  | "manifest-miss-and-api-miss"
  | "api-error"
  | "disk-html-missing"
  | "html-empty"
  | "parser-threw";

export interface ResolveFailure {
  reason: ResolveFailureReason;
  /** Human-readable detail. For api-error / parser-threw, includes the
   *  underlying error message. Safe to surface in warnings. */
  detail: string;
}

export interface TemplateResolver {
  /**
   * Resolve a Klaviyo template id to a fully-parsed Redo EmailTemplate, or
   * a typed failure describing why it couldn't be resolved. Caller decides
   * whether to fall back to a blank placeholder and what warning to emit.
   */
  resolve(
    klaviyoTemplateId: string,
  ): Promise<ResolvedTemplate | { failure: ResolveFailure }>;
}

/**
 * Build a resolver backed by the on-disk `migrations/<merchant>/` directory
 * that `extract-templates.ts` produces. First call loads the manifest +
 * file index; subsequent calls cache per template id.
 */
export function createTemplateResolver(opts: {
  /** Absolute or cwd-relative path to the migrations/<merchant>/ directory. */
  merchantDir: string;
  /** Klaviyo account (optional) — enables `{{ organization.* }}` substitution. */
  account: KlaviyoAccount | null;
  /** Pass true to suppress the inline-coupon LLM call (for CI / offline tests). */
  skipAi: boolean;
  /**
   * Optional Klaviyo API key. When set, templates missing from the local
   * manifest are fetched on-demand via GET /templates/{id}/. Flow-embedded
   * templates (created inside a flow's send-email action) are typically NOT
   * returned by the /templates/ listing endpoint, so this fallback is the
   * only way to pick them up.
   */
  klaviyoApiKey?: string | null;
}): TemplateResolver | null {
  const manifestPath = join(opts.merchantDir, "templates-manifest.json");

  // Resolver is useful even without a manifest if we have a Klaviyo API key —
  // every template then comes from the live API.
  let manifest: TemplateManifest | null = null;
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      manifest = null;
    }
  }
  if (!manifest && !opts.klaviyoApiKey) return null;

  const byId = new Map<string, TemplateManifest["templates"][number]>();
  for (const t of manifest?.templates ?? []) {
    if (t.id) byId.set(t.id, t);
  }

  type ResolverResult = ResolvedTemplate | { failure: ResolveFailure };
  const cache = new Map<string, Promise<ResolverResult>>();

  type Source = { html: string; meta: TemplateMetadata };
  type SourceOrFailure = Source | { failure: ResolveFailure };

  async function loadFromDisk(
    entry: TemplateManifest["templates"][number],
  ): Promise<SourceOrFailure> {
    if (!entry.files?.html) {
      return {
        failure: {
          reason: "disk-html-missing",
          detail: `manifest entry has no html file path`,
        },
      };
    }
    const htmlPath = entry.files.html;
    const resolvedHtmlPath = existsSync(htmlPath)
      ? htmlPath
      : join(opts.merchantDir, "..", "..", htmlPath);
    if (!existsSync(resolvedHtmlPath)) {
      return {
        failure: {
          reason: "disk-html-missing",
          detail: `manifest html path does not exist on disk: ${htmlPath}`,
        },
      };
    }
    const html = readFileSync(resolvedHtmlPath, "utf8");

    let meta: TemplateMetadata = {
      name: entry.name,
      subject: entry.name,
      created: entry.created,
      editorType: entry.editor_type,
    };
    if (entry.files.json) {
      const jsonPath = existsSync(entry.files.json)
        ? entry.files.json
        : join(opts.merchantDir, "..", "..", entry.files.json);
      if (existsSync(jsonPath)) {
        try {
          const raw = JSON.parse(readFileSync(jsonPath, "utf8"));
          meta = {
            name: raw.attributes?.name || raw.name || meta.name,
            subject: raw.attributes?.name || raw.name || meta.subject,
            created: raw.attributes?.created || meta.created,
            editorType: raw.attributes?.editor_type || meta.editorType,
          };
        } catch {
          // keep manifest-derived meta
        }
      }
    }
    return { html, meta };
  }

  async function loadFromApi(
    klaviyoTemplateId: string,
  ): Promise<SourceOrFailure> {
    if (!opts.klaviyoApiKey) {
      return {
        failure: {
          reason: "manifest-miss-no-api-key",
          detail: `template ${klaviyoTemplateId} is not in the local manifest and no Klaviyo API key was configured to fetch it`,
        },
      };
    }
    let res: any;
    try {
      res = await klaviyo(
        `/templates/${klaviyoTemplateId}/`,
        opts.klaviyoApiKey,
      );
    } catch (e: any) {
      return {
        failure: {
          reason: "api-error",
          detail: `Klaviyo /templates/${klaviyoTemplateId}/ failed: ${e?.message ?? String(e)}`,
        },
      };
    }
    const attrs = res?.data?.attributes ?? {};
    if (typeof attrs.html !== "string" || attrs.html.length === 0) {
      return {
        failure: {
          reason: "html-empty",
          detail: `Klaviyo /templates/${klaviyoTemplateId}/ returned no html (editor_type=${attrs.editor_type ?? "?"})`,
        },
      };
    }
    return {
      html: attrs.html,
      meta: {
        name: attrs.name,
        subject: attrs.name,
        created: attrs.created,
        editorType: attrs.editor_type,
      },
    };
  }

  async function resolveUncached(
    klaviyoTemplateId: string,
  ): Promise<ResolverResult> {
    // Disk first (fast, offline, deterministic), Klaviyo API fallback for
    // flow-embedded templates that don't appear in the /templates/ listing.
    const diskEntry = byId.get(klaviyoTemplateId);
    const sourceResult = diskEntry
      ? await loadFromDisk(diskEntry)
      : await loadFromApi(klaviyoTemplateId);
    if ("failure" in sourceResult) {
      // If disk lookup failed AND we have an API key, try the API as a
      // fallback. This is the common case for flow-embedded templates the
      // manifest claims to know about but whose HTML file is missing.
      if (diskEntry && opts.klaviyoApiKey) {
        const apiResult = await loadFromApi(klaviyoTemplateId);
        if ("failure" in apiResult) {
          return {
            failure: {
              reason: "manifest-miss-and-api-miss",
              detail: `${sourceResult.failure.detail}; api fallback: ${apiResult.failure.detail}`,
            },
          };
        }
        return await parseSource(apiResult);
      }
      return sourceResult;
    }
    return await parseSource(sourceResult);
  }

  async function parseSource(source: Source): Promise<ResolverResult> {
    try {
      const result = await exportTemplateFromHtml(source.html, source.meta, {
        account: opts.account,
        skipAi: opts.skipAi,
      });
      return { template: result.template, warnings: result.warnings };
    } catch (e: any) {
      return {
        failure: {
          reason: "parser-threw",
          detail: `exportTemplateFromHtml threw: ${e?.message ?? String(e)}`,
        },
      };
    }
  }

  return {
    async resolve(klaviyoTemplateId: string) {
      if (!klaviyoTemplateId) {
        return {
          failure: {
            reason: "manifest-miss-no-api-key",
            detail: `empty template id`,
          },
        };
      }
      if (!cache.has(klaviyoTemplateId)) {
        cache.set(klaviyoTemplateId, resolveUncached(klaviyoTemplateId));
      }
      return cache.get(klaviyoTemplateId)!;
    },
  };
}

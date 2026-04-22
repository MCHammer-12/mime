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

export interface TemplateResolver {
  /**
   * Resolve a Klaviyo template id to a fully-parsed Redo EmailTemplate.
   * Returns null when the template can't be resolved (missing from the
   * manifest, HTML file gone, parser threw) — caller falls back to a blank
   * placeholder and emits its own warning.
   */
  resolve(klaviyoTemplateId: string): Promise<ResolvedTemplate | null>;
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

  const cache = new Map<string, Promise<ResolvedTemplate | null>>();

  async function loadFromDisk(
    entry: TemplateManifest["templates"][number],
  ): Promise<{ html: string; meta: TemplateMetadata } | null> {
    if (!entry.files?.html) return null;
    const htmlPath = entry.files.html;
    const resolvedHtmlPath = existsSync(htmlPath)
      ? htmlPath
      : join(opts.merchantDir, "..", "..", htmlPath);
    if (!existsSync(resolvedHtmlPath)) return null;
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
  ): Promise<{ html: string; meta: TemplateMetadata } | null> {
    if (!opts.klaviyoApiKey) return null;
    try {
      const res = await klaviyo(
        `/templates/${klaviyoTemplateId}/`,
        opts.klaviyoApiKey,
      );
      const attrs = res?.data?.attributes ?? {};
      if (typeof attrs.html !== "string" || attrs.html.length === 0) return null;
      return {
        html: attrs.html,
        meta: {
          name: attrs.name,
          subject: attrs.name,
          created: attrs.created,
          editorType: attrs.editor_type,
        },
      };
    } catch {
      return null;
    }
  }

  async function resolveUncached(
    klaviyoTemplateId: string,
  ): Promise<ResolvedTemplate | null> {
    // Disk first (fast, offline, deterministic), Klaviyo API fallback for
    // flow-embedded templates that don't appear in the /templates/ listing.
    const diskEntry = byId.get(klaviyoTemplateId);
    const source = diskEntry
      ? await loadFromDisk(diskEntry)
      : await loadFromApi(klaviyoTemplateId);
    if (!source) return null;
    try {
      const result = await exportTemplateFromHtml(source.html, source.meta, {
        account: opts.account,
        skipAi: opts.skipAi,
      });
      return { template: result.template, warnings: result.warnings };
    } catch {
      return null;
    }
  }

  return {
    async resolve(klaviyoTemplateId: string) {
      if (!klaviyoTemplateId) return null;
      if (!cache.has(klaviyoTemplateId)) {
        cache.set(klaviyoTemplateId, resolveUncached(klaviyoTemplateId));
      }
      return cache.get(klaviyoTemplateId)!;
    },
  };
}

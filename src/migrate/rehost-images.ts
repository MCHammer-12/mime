// Re-host Klaviyo-hosted images on Redo before a template is created.
//
// The parser passes image URLs through verbatim, so a migrated email keeps
// pointing at `d3k81ch9hvuctc.cloudfront.net`. That works — right up until the
// merchant stops paying Klaviyo, at which point every image in every migrated
// email breaks at once, months after anyone was looking. Bailey's Blossoms
// carried 167 of them across 19 templates; it was the entire remaining fidelity
// gap on that store and it is not merchant-specific.
//
// The core here is pure so it can be tested without a network: find the URLs,
// rewrite them against a map. The async shell downloads each unique asset and
// hands the bytes to an injected uploader.

/** Klaviyo's asset CDN. Only URLs on this host are rewritten. */
export const KLAVIYO_ASSET_HOST = "d3k81ch9hvuctc.cloudfront.net";

/** Fields that hold an image URL in a parsed template — section and column
 *  level today, but the walk is recursive so nesting depth doesn't matter. */
const IMAGE_URL_KEYS = new Set(["imageUrl"]);

export interface RehostSummary {
  /** Unique source URLs uploaded to Redo. */
  rehosted: number;
  /** Fields rewritten (higher than `rehosted` when an asset is reused). */
  rewritten: number;
  failed: Array<{ url: string; reason: string }>;
}

function isKlaviyoAsset(value: unknown): value is string {
  return typeof value === "string" && value.includes(KLAVIYO_ASSET_HOST);
}

/** Every distinct Klaviyo-hosted image URL in a parsed template. */
export function findKlaviyoImageUrls(node: unknown): string[] {
  const found = new Set<string>();
  const visit = (n: unknown) => {
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (!n || typeof n !== "object") return;
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (IMAGE_URL_KEYS.has(k) && isKlaviyoAsset(v)) found.add(v);
      else visit(v);
    }
  };
  visit(node);
  return [...found];
}

/**
 * Swap every image URL present in `map` for its replacement. Returns a new
 * object — the caller's parse is left alone, so a failed upload can fall back
 * to the original template without having half-mutated it.
 */
export function rewriteImageUrls<T>(
  node: T,
  map: Map<string, string>,
): { node: T; rewritten: number } {
  let rewritten = 0;
  const visit = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(visit);
    if (!n || typeof n !== "object") return n;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (IMAGE_URL_KEYS.has(k) && isKlaviyoAsset(v) && map.has(v)) {
        out[k] = map.get(v)!;
        rewritten++;
      } else {
        out[k] = visit(v);
      }
    }
    return out;
  };
  return { node: visit(node) as T, rewritten };
}

/** Klaviyo media URLs end in a real filename ("ded7d827.jpeg"). Fall back to
 *  the content type when one doesn't, so the upload isn't extensionless. */
export function fileNameFor(url: string, contentType?: string | null): string {
  const base = (url.split("?")[0].split("/").pop() || "").trim();
  if (base.includes(".")) return base;
  const ext = (contentType ?? "").split("/")[1]?.split(";")[0]?.trim();
  const stem = base || "image";
  return ext ? `${stem}.${ext}` : `${stem}.png`;
}

/**
 * Uploads are cached for the life of the process so a logo shared by four
 * welcome emails is fetched once. Keyed by credential as well as URL: the
 * long-running server imports for more than one merchant, and a URL cached
 * across that boundary would point one merchant's email at another's file
 * store.
 */
const uploadCache = new Map<string, string>();

export type Uploader = (
  bytes: Uint8Array,
  fileName: string,
  contentType?: string,
) => Promise<string>;

export async function rehostKlaviyoImages<T extends Record<string, any>>(
  template: T,
  upload: Uploader,
  cacheKey: string,
): Promise<{ template: T; summary: RehostSummary }> {
  const urls = findKlaviyoImageUrls(template);
  const summary: RehostSummary = { rehosted: 0, rewritten: 0, failed: [] };
  if (urls.length === 0) return { template, summary };

  const map = new Map<string, string>();
  for (const url of urls) {
    const cached = uploadCache.get(`${cacheKey}\n${url}`);
    if (cached) {
      map.set(url, cached);
      continue;
    }
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`GET ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      // Redo serves back whatever type the upload declared, and an untyped
      // Blob lands as application/octet-stream where a native Redo upload
      // would be image/jpeg. Only forward a type that is actually an image.
      const type = res.headers.get("content-type");
      const hosted = await upload(
        bytes,
        fileNameFor(url, type),
        type?.startsWith("image/") ? type.split(";")[0].trim() : undefined,
      );
      uploadCache.set(`${cacheKey}\n${url}`, hosted);
      map.set(url, hosted);
      summary.rehosted++;
    } catch (e: any) {
      // Keep the Klaviyo URL. The email still renders today, and the failure
      // is reported rather than turning a fidelity gap into a broken import.
      summary.failed.push({ url, reason: e?.message ?? String(e) });
    }
  }

  const { node, rewritten } = rewriteImageUrls(template, map);
  summary.rewritten = rewritten;
  return { template: node, summary };
}

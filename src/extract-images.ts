import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

type ImgEntry = {
  url: string;
  hash: string;
  path: string;
  bytes: number;
  referenced_by: Set<string>;
};

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractUrls(html: string): string[] {
  const urls = new Set<string>();
  const imgRe = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html))) urls.add(decodeEntities(m[1]));
  const bgRe = /background-image\s*:\s*url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  while ((m = bgRe.exec(html))) urls.add(decodeEntities(m[2]));
  return [...urls].filter((u) => {
    if (u.startsWith("data:")) return false;
    if (u.includes("{{") || u.includes("{%")) return false;
    if (!/^https?:\/\//i.test(u)) return false;
    return true;
  });
}

function sanitizeBasename(url: string): string {
  try {
    const u = new URL(url);
    const b = basename(u.pathname) || "image";
    return b.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "image";
  } catch {
    return "image";
  }
}

function extFromContentType(ct: string | null): string {
  if (!ct) return "";
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp",
    "image/avif": ".avif",
  };
  const key = ct.split(";")[0].trim().toLowerCase();
  return map[key] ?? "";
}

async function downloadOne(url: string): Promise<{ bytes: Buffer; contentType: string | null }> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  return { bytes: Buffer.from(ab), contentType: res.headers.get("content-type") };
}

async function main() {
  const merchant = process.env.MERCHANT ?? "unknown";
  const tplDir = join("migrations", merchant, "templates");
  const imgDir = join("migrations", merchant, "images");
  await mkdir(imgDir, { recursive: true });

  const entries = await readdir(tplDir);
  const htmlFiles = entries.filter((f) => f.endsWith(".html"));
  console.log(`scanning ${htmlFiles.length} templates for merchant=${merchant}...`);

  const urlToTemplates = new Map<string, Set<string>>();
  for (const f of htmlFiles) {
    const templateId = f.split("-")[0];
    const html = await readFile(join(tplDir, f), "utf8");
    for (const u of extractUrls(html)) {
      if (!urlToTemplates.has(u)) urlToTemplates.set(u, new Set());
      urlToTemplates.get(u)!.add(templateId);
    }
  }
  console.log(`found ${urlToTemplates.size} unique image URLs`);

  const byHash = new Map<string, ImgEntry>();
  const errors: { url: string; error: string }[] = [];
  let downloaded = 0;
  let deduped = 0;

  const urls = [...urlToTemplates.keys()];
  const CONCURRENCY = 10;
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= urls.length) return;
      const url = urls[i];
      try {
        const { bytes, contentType } = await downloadOne(url);
        const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
        const refs = urlToTemplates.get(url)!;
        const existing = byHash.get(hash);
        if (existing) {
          deduped++;
          for (const r of refs) existing.referenced_by.add(r);
          continue;
        }
        let base = sanitizeBasename(url);
        if (!/\.[a-zA-Z0-9]+$/.test(base)) base += extFromContentType(contentType) || ".bin";
        const filename = `${hash}-${base}`;
        const path = join(imgDir, filename);
        await writeFile(path, bytes);
        downloaded++;
        byHash.set(hash, {
          url,
          hash,
          path,
          bytes: bytes.length,
          referenced_by: new Set(refs),
        });
      } catch (e: any) {
        errors.push({ url, error: e?.message ?? String(e) });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const manifest = {
    merchant,
    fetched_at: new Date().toISOString(),
    images: [...byHash.values()].map((e) => ({
      url: e.url,
      hash: e.hash,
      path: e.path,
      bytes: e.bytes,
      referenced_by: [...e.referenced_by].sort(),
    })),
    errors,
  };

  await writeFile(
    join("migrations", merchant, "images-manifest.json"),
    JSON.stringify(manifest, null, 2)
  );

  console.log(
    `urls=${urls.length} downloaded=${downloaded} deduped=${deduped} errors=${errors.length}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

const API = "https://a.klaviyo.com/api";
const REVISION = "2025-10-15";

export async function klaviyo(path: string, key: string): Promise<any> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${API}${path}`, {
      headers: {
        Authorization: `Klaviyo-API-Key ${key}`,
        revision: REVISION,
        accept: "application/json",
      },
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "2");
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}: ${await res.text()}`);
    return res.json();
  }
  throw new Error(`rate limited 6x on ${path}`);
}

export async function paginate<T = any>(startPath: string, key: string): Promise<T[]> {
  const all: T[] = [];
  let url: string | null = startPath;
  while (url) {
    const body: any = await klaviyo(url, key);
    all.push(...body.data);
    const next: string | null = body.links?.next ?? null;
    url = next ? next.replace(API, "") : null;
  }
  return all;
}

export function slug(s: string | null, fallback: string): string {
  if (!s) return fallback;
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || fallback;
}

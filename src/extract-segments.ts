import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { klaviyo, paginate, slug } from "./klaviyo.js";

// Pull every Klaviyo segment with its full `definition` (condition tree) and
// `profile_count`. Mirrors src/extract-flows.ts. Klaviyo segments are dynamic
// by nature (static audiences live under /lists/); the definition is what we
// translate into a Redo dynamic segment.
//
// Usage:
//   KLAVIYO_API_KEY=... MERCHANT=<name> npx tsx src/extract-segments.ts

async function main() {
  const key = process.env.KLAVIYO_API_KEY;
  const merchant = process.env.MERCHANT ?? "unknown";
  if (!key) throw new Error("KLAVIYO_API_KEY not set");

  const outDir = join("migrations", merchant, "segments");
  await mkdir(outDir, { recursive: true });

  console.log(`listing segments for merchant=${merchant}...`);
  const segments = await paginate("/segments/", key);
  console.log(`found ${segments.length} segments`);

  const manifest: any[] = [];
  for (const s of segments as any[]) {
    const id = s.id;
    const name = s.attributes?.name ?? null;
    const base = `${id}-${slug(name, id)}`;

    // definition (condition tree) comes back by default; profile_count is the
    // only valid additional-field (rate-limited 1/s — klaviyo() backs off on 429).
    const detail = await klaviyo(
      `/segments/${id}/?additional-fields%5Bsegment%5D=profile_count`,
      key,
    );
    await writeFile(join(outDir, `${base}.json`), JSON.stringify(detail, null, 2));

    const attrs = detail.data?.attributes ?? {};
    const groups = attrs.definition?.condition_groups ?? [];
    const condCount = groups.reduce(
      (n: number, g: any) => n + (g.conditions?.length ?? 0),
      0,
    );
    const profileCount = attrs.profile_count ?? null;

    manifest.push({
      id,
      name,
      profile_count: profileCount,
      group_count: groups.length,
      condition_count: condCount,
      file: join(outDir, `${base}.json`),
    });
    console.log(
      `  ${id} ${name ?? "(unnamed)"} groups=${groups.length} conditions=${condCount} profiles=${profileCount ?? "?"}`,
    );
  }

  await writeFile(
    join("migrations", merchant, "segments-manifest.json"),
    JSON.stringify(
      { merchant, fetched_at: new Date().toISOString(), segments: manifest },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${segments.length} segments to migrations/${merchant}/segments/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

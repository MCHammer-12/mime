import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paginate, slug } from "./klaviyo.js";

async function main() {
  const key = process.env.KLAVIYO_API_KEY;
  const merchant = process.env.MERCHANT ?? "unknown";
  if (!key) throw new Error("KLAVIYO_API_KEY not set");

  const outDir = join("migrations", merchant, "templates");
  await mkdir(outDir, { recursive: true });

  console.log(`fetching templates for merchant=${merchant}...`);
  const templates = await paginate("/templates/", key);
  console.log(`found ${templates.length} templates`);

  const manifest: any[] = [];
  for (const t of templates as any[]) {
    const id = t.id;
    const name = t.attributes.name;
    const base = `${id}-${slug(name, id)}`;
    const jsonPath = join(outDir, `${base}.json`);
    const htmlPath = join(outDir, `${base}.html`);

    await writeFile(jsonPath, JSON.stringify(t, null, 2));
    if (t.attributes.html) await writeFile(htmlPath, t.attributes.html);

    manifest.push({
      id,
      name,
      editor_type: t.attributes.editor_type,
      updated: t.attributes.updated,
      html_bytes: t.attributes.html?.length ?? 0,
      files: { json: jsonPath, html: t.attributes.html ? htmlPath : null },
    });
  }

  await writeFile(
    join("migrations", merchant, "templates-manifest.json"),
    JSON.stringify({ merchant, fetched_at: new Date().toISOString(), templates: manifest }, null, 2)
  );
  console.log(`wrote ${templates.length} templates to migrations/${merchant}/templates/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

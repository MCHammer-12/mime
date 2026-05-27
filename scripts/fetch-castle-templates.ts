import { klaviyo } from "../src/klaviyo.js";
import { writeFileSync } from "node:fs";

const KEY = process.env.KLAVIYO_API_KEY!;
const IDS = process.argv.slice(2);
if (IDS.length === 0) {
  console.error("usage: tsx scripts/fetch-castle-templates.ts <id> [<id>...]");
  process.exit(1);
}

async function main() {
  for (const id of IDS) {
    try {
      const full = await klaviyo(`/templates/${id}/`, KEY);
      const attrs = full?.data?.attributes ?? {};
      const name = attrs.name ?? id;
      const editor = attrs.editor_type ?? "?";
      const html = attrs.html ?? "";
      console.log(`${id}: name="${name}" editor_type=${editor} htmlBytes=${html.length}`);
      const safe = (name as string).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      const base = `migrations/castle-sports/templates/${id}-${safe}`;
      writeFileSync(`${base}.html`, html);
      writeFileSync(`${base}.json`, JSON.stringify(full.data, null, 2));
      console.log(`  → ${base}.html`);
    } catch (err) {
      console.error(`${id}: ${err}`);
    }
  }
}

main();

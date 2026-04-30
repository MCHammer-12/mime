import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { klaviyo, paginate, slug } from "./klaviyo.js";

async function main() {
  const key = process.env.KLAVIYO_API_KEY;
  const merchant = process.env.MERCHANT ?? "unknown";
  if (!key) throw new Error("KLAVIYO_API_KEY not set");

  const outDir = join("migrations", merchant, "campaigns");
  await mkdir(outDir, { recursive: true });

  console.log(`listing campaigns for merchant=${merchant}...`);
  // Klaviyo's filter spec wants double-quoted strings; some accounts reject
  // the single-quoted form with a 400. Match the working pattern used in
  // src/migrate/server.ts (flow-messages filter).
  const filter = encodeURIComponent(`equals(messages.channel,"email")`);
  const campaigns = await paginate(`/campaigns/?filter=${filter}`, key);
  console.log(`found ${campaigns.length} campaigns`);

  const manifest: any[] = [];
  for (const c of campaigns as any[]) {
    const id = c.id;
    const name = c.attributes?.name ?? null;
    const status = c.attributes?.status ?? null;
    const sendTime = c.attributes?.send_time ?? null;
    const base = `${id}-${slug(name, id)}`;

    const messages = await paginate(`/campaigns/${id}/campaign-messages/`, key);
    const templates: Record<string, any> = {};
    for (const m of messages as any[]) {
      try {
        const tpl = await klaviyo(`/campaign-messages/${m.id}/template/`, key);
        templates[m.id] = tpl.data ?? null;
      } catch (e) {
        templates[m.id] = { error: String(e) };
      }
    }

    const bundle = { campaign: c, messages, templates };
    await writeFile(join(outDir, `${base}.json`), JSON.stringify(bundle, null, 2));

    const templateIds = Object.values(templates)
      .map((t: any) => t?.id ?? null)
      .filter((x) => x);

    manifest.push({
      id,
      name,
      status,
      send_time: sendTime,
      message_count: messages.length,
      template_ids: templateIds,
      file: join(outDir, `${base}.json`),
    });
    console.log(`  ${id} ${name ?? "(unnamed)"} [${status}] messages=${messages.length} templates=${templateIds.length}`);
  }

  await writeFile(
    join("migrations", merchant, "campaigns-manifest.json"),
    JSON.stringify({ merchant, fetched_at: new Date().toISOString(), campaigns: manifest }, null, 2)
  );
  console.log(`\nwrote ${campaigns.length} campaigns to migrations/${merchant}/campaigns/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

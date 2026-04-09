import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { klaviyo, paginate, slug } from "./klaviyo.js";

async function main() {
  const key = process.env.KLAVIYO_API_KEY;
  const merchant = process.env.MERCHANT ?? "unknown";
  if (!key) throw new Error("KLAVIYO_API_KEY not set");

  const outDir = join("migrations", merchant, "flows");
  await mkdir(outDir, { recursive: true });

  console.log(`listing flows for merchant=${merchant}...`);
  const flows = await paginate("/flows/", key);
  console.log(`found ${flows.length} flows`);

  const manifest: any[] = [];
  for (const f of flows as any[]) {
    const id = f.id;
    const name = f.attributes?.name ?? null;
    const status = f.attributes?.status ?? null;
    const trigger = f.attributes?.trigger_type ?? null;
    const base = `${id}-${slug(name, id)}`;

    const detail = await klaviyo(`/flows/${id}/?additional-fields%5Bflow%5D=definition`, key);
    await writeFile(join(outDir, `${base}.json`), JSON.stringify(detail, null, 2));

    const defn = detail.data?.attributes?.definition;
    const actions = defn?.actions ?? [];
    const branches = actions.filter((a: any) => a.type === "conditional-split" || a.type === "trigger-split").length;
    const sends = actions.filter((a: any) => a.type === "send-email" || a.type === "send-sms").length;
    const metricId = defn?.triggers?.[0]?.id ?? null;

    manifest.push({ id, name, status, trigger_type: trigger, metric_id: metricId, action_count: actions.length, send_count: sends, branch_count: branches, file: join(outDir, `${base}.json`) });
    console.log(`  ${id} ${name ?? "(unnamed)"} [${status}] ${trigger} actions=${actions.length} sends=${sends} branches=${branches}`);
  }

  await writeFile(
    join("migrations", merchant, "flows-manifest.json"),
    JSON.stringify({ merchant, fetched_at: new Date().toISOString(), flows: manifest }, null, 2)
  );
  console.log(`\nwrote ${flows.length} flows to migrations/${merchant}/flows/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

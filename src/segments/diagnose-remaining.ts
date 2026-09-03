import { klaviyo, paginate } from "../klaviyo.js";
import { fetchAllMetrics } from "../extract-metrics.js";
import { translateSegment } from "./translate.js";
import { getSegmentCount, createDynamicSegment } from "./redo-client.js";

async function main() {
  const key = process.env.KLAVIYO_API_KEY!;
  const jwt = process.env.REDO_JWT!;
  const metrics = await fetchAllMetrics(key);
  const list = await paginate("/segments/?page%5Bsize%5D=10", key);
  const find = (n: string) => list.find((s: any) => s.attributes?.name === n);

  const def = async (n: string) => {
    const s = find(n);
    if (!s) { console.log(`NOT FOUND: ${n}`); return null; }
    const d = await klaviyo(`/segments/${s.id}/?additional-fields%5Bsegment%5D=profile_count`, key);
    return { id: s.id, attrs: d.data?.attributes ?? {} };
  };

  // 1) Holiday Shoppers — translate, attempt create, capture the exact validation error
  const hs = await def("GRID & PIXEL Holiday Shoppers");
  if (hs) {
    const t = translateSegment({ id: hs.id, name: "GRID & PIXEL Holiday Shoppers", definition: hs.attrs.definition, profileCount: hs.attrs.profile_count }, { metrics });
    console.log("=== HOLIDAY SHOPPERS translated query ===");
    console.log(JSON.stringify(t.query, null, 1));
    try {
      const c = await createDynamicSegment("GRID & PIXEL Holiday Shoppers", t.query, { jwt });
      console.log("created OK →", c.id);
    } catch (e: any) {
      console.log("CREATE ERROR:", String(e.message));
    }
  }

  // 2) + 3) raw defs for the two native rebuilds
  for (const n of ["GRID & PIXEL Accepts Marketing, Not Subscribed", "Unengaged (Post-Sunset Flow)"]) {
    const d = await def(n);
    console.log(`\n=== RAW DEF: ${n} ===`);
    console.log(JSON.stringify(d?.attrs?.definition, null, 1));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

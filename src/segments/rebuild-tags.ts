// Rebuild the held device/popup/VIP segments using Redo customer TAGS in place
// of the Klaviyo custom properties Redo can't map. Keeps each segment's other
// (translatable) conditions via translateSegment, then AND-s the tag condition.
//
// Usage: KLAVIYO_API_KEY=... REDO_JWT=... npx tsx src/segments/rebuild-tags.ts

import { klaviyo, paginate } from "../klaviyo.js";
import { fetchAllMetrics } from "../extract-metrics.js";
import { translateSegment } from "./translate.js";
import { getSegmentCount, createDynamicSegment } from "./redo-client.js";

// segment name -> customer tags to require (ANY of them)
const TAGMAP: Record<string, string[]> = {
  "Apple Subscribers | Cube": ["iphone"],
  "Samsung Subscribers | Cube": ["Galaxy"],
  "Google Subscribers | Cube": ["pixel"],
  "Alia Popup 1 | Cube": ["Alia Popup 1 | Cube"],
  "[SEND] VIPs over $250": ["Gold VIP", "Silver VIP", "Bronze VIP"],
};

function tagBlock(values: string[]) {
  return {
    operator: "AND" as const,
    conditions: [{
      type: "customer_attribute",
      whereCondition: {
        type: "token_list",
        dimension: "customer-tags",
        comparison: { type: "list", operator: "any", values },
      },
    }],
  };
}

async function main() {
  const key = process.env.KLAVIYO_API_KEY!;
  const jwt = process.env.REDO_JWT!;
  const metrics = await fetchAllMetrics(key);
  const list = await paginate("/segments/?page%5Bsize%5D=10", key);

  for (const [name, tags] of Object.entries(TAGMAP)) {
    const s = list.find((x: any) => x.attributes?.name === name);
    if (!s) { console.log(`  ? not found in Klaviyo: ${name}`); continue; }
    const detail = await klaviyo(`/segments/${s.id}/?additional-fields%5Bsegment%5D=profile_count`, key);
    const attrs = detail.data?.attributes ?? {};
    const t = translateSegment(
      { id: s.id, name, definition: attrs.definition ?? null, profileCount: attrs.profile_count ?? null },
      { metrics },
    );
    // keep whatever translated (e.g. email consent); append the tag requirement
    const keptBlocks = t.query.conditionBlocks ?? [];
    const query: any = { conjunction: "AND", conditionBlocks: [...keptBlocks, tagBlock(tags)] };
    const keptSummary = keptBlocks.reduce((n: number, b: any) => n + b.conditions.length, 0);

    let cnt: number | string = "?";
    try { cnt = (await getSegmentCount(query, { jwt })).allCount; } catch (e: any) { cnt = `count-err`; }
    const created = await createDynamicSegment(name, query, { jwt });
    console.log(`  ✓ ${name}  → ${created.id}   [kept ${keptSummary} cond(s) + tag any(${tags.join(", ")})]  redoCount=${cnt}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

// Batch: migrate ALL Klaviyo segments in an account to Redo, faithfully.
// Reuses the tested per-condition translator. DRY_RUN reports coverage without
// writing. Skips warming segments (name matches WARMING_RE) and de-dups against
// existing Redo segments by name.
//
// Usage:
//   KLAVIYO_API_KEY=... REDO_JWT=... [DRY_RUN=1] npx tsx src/segments/migrate-all.ts

import { klaviyo, paginate } from "../klaviyo.js";
import { fetchAllMetrics } from "../extract-metrics.js";
import { translateSegment } from "./translate.js";
import { getSegmentCount, createDynamicSegment } from "./redo-client.js";

const WARMING_RE = /warm|warm[\s-]?up|warming/i;
const DRY = process.env.DRY_RUN === "1";
const SERVER = process.env.REDO_SERVER_BASE ?? "https://app-server.getredo.com";

async function existingRedoNames(jwt: string): Promise<Set<string>> {
  const res = await fetch(`${SERVER}/marketing-rpc/fetchTeamSegments`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: jwt },
    body: JSON.stringify({ input: { page: 1, pageSize: 200 } }),
  });
  const j: any = await res.json();
  const segs = j?.output?.segments ?? [];
  return new Set(segs.map((s: any) => String(s.name).trim().toLowerCase()));
}

async function main() {
  const key = process.env.KLAVIYO_API_KEY!;
  const jwt = process.env.REDO_JWT!;
  if (!key) throw new Error("KLAVIYO_API_KEY not set");
  if (!jwt && !DRY) throw new Error("REDO_JWT not set (or DRY_RUN=1)");

  console.log("[metrics] fetching…");
  const metrics = await fetchAllMetrics(key);
  console.log(`[metrics] ${Object.keys(metrics).length}`);

  console.log("[list] paginating segments…");
  const list = await paginate("/segments/?page%5Bsize%5D=10", key);
  console.log(`[list] ${list.length} segments`);

  const existing = jwt ? await existingRedoNames(jwt) : new Set<string>();

  const rows: any[] = [];
  for (const s of list) {
    const id = s.id;
    const name = s.attributes?.name ?? id;
    if (WARMING_RE.test(name)) {
      rows.push({ name, status: "SKIP-warming" });
      console.log(`  [SKIP-warm] ${name}`);
      continue;
    }
    // fetch full definition + profile count (rate-limited; klaviyo() retries 429)
    const detail = await klaviyo(`/segments/${id}/?additional-fields%5Bsegment%5D=profile_count`, key);
    const attrs = detail.data?.attributes ?? {};
    const t = translateSegment(
      { id, name: attrs.name ?? name, definition: attrs.definition ?? null, profileCount: attrs.profile_count ?? null },
      { metrics },
    );
    const nConds = t.query.conditionBlocks.reduce((n: number, b: any) => n + b.conditions.length, 0);
    let redoCount: number | null = null;
    if (jwt && t.importable) {
      try { redoCount = (await getSegmentCount(t.query, { jwt })).allCount; } catch { redoCount = null; }
    }
    const fidelity = !t.importable ? "NOT-IMPORTABLE" : t.dropped.length ? "PARTIAL(dropped)" : t.substitutions.length ? "SUBSTITUTED" : "EXACT";
    const dup = existing.has(name.trim().toLowerCase());
    rows.push({ name, status: fidelity, dup, kProfiles: attrs.profile_count, redoCount, nConds,
      subs: t.substitutions.map((x: any) => x.klaviyoSummary), dropped: t.dropped.map((d: any) => `${d.klaviyoType}${d.dimension ? `[${d.dimension}]` : ""}: ${d.reason}`), t });
    console.log(`  [${fidelity}]${dup ? "[DUP]" : ""} ${name}  conds=${nConds} kProfiles=${attrs.profile_count ?? "?"} redo=${redoCount ?? "-"}` +
      (t.substitutions.length ? `  ~${t.substitutions.length}` : "") + (t.dropped.length ? `  ✗${t.dropped.length}` : ""));
  }

  // summary
  const by = (st: string) => rows.filter((r) => r.status === st).length;
  console.log(`\n=== ${rows.length} segments: EXACT ${by("EXACT")} · SUBSTITUTED ${by("SUBSTITUTED")} · PARTIAL ${by("PARTIAL(dropped)")} · NOT-IMPORTABLE ${by("NOT-IMPORTABLE")} · SKIP-warming ${by("SKIP-warming")} ===`);
  const dups = rows.filter((r) => r.dup).length;
  if (dups) console.log(`(${dups} already exist in Redo by name — would skip)`);

  if (DRY) {
    console.log("\nDRY_RUN — nothing created. Detail on non-exact:");
    for (const r of rows.filter((r) => ["SUBSTITUTED", "PARTIAL(dropped)", "NOT-IMPORTABLE"].includes(r.status))) {
      console.log(`  • ${r.name} [${r.status}]`);
      for (const s of r.subs ?? []) console.log(`      ~ ${s}`);
      for (const d of r.dropped ?? []) console.log(`      ✗ ${d}`);
    }
    return;
  }

  // CREATE: importable + not duplicate. (Skip NOT-IMPORTABLE + warming + dups.)
  console.log("\n[create] importable, non-duplicate segments…");
  const created: any[] = [];
  for (const r of rows) {
    // Only create faithfully-translatable segments. PARTIAL drops conditions
    // (would over-match); NOT-IMPORTABLE has nothing; warming + dups skipped.
    if (!["EXACT", "SUBSTITUTED"].includes(r.status) || r.dup) continue;
    try {
      const c = await createDynamicSegment(r.t.name, r.t.query, { jwt });
      created.push({ name: c.name, id: c.id, status: r.status });
      console.log(`  ✓ ${c.name} → ${c.id}  [${r.status}]`);
    } catch (e: any) {
      console.log(`  ✗ ${r.name} — ${String(e.message).slice(0, 160)}`);
    }
  }
  console.log(`\n=== created ${created.length} segments ===`);
}

main().catch((e) => { console.error(e); process.exit(1); });

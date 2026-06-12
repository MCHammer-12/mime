// Server-side segment migration: list / preview / job-backed import.
//
// Wires the src/segments/* engine into the dashboard's job model so the
// substitution-approval + count-verification gates run through the existing
// needs_input modal (ctrl.prompt) and NDJSON job stream.

import { fetchAllMetrics, type MetricLookup } from "../extract-metrics.js";
import { klaviyo, paginate } from "../klaviyo.js";
import { RedoAuthExpiredError } from "./import-rpc.js";
import type { JobSummary, RunController } from "./jobs.js";
import { createDynamicSegment } from "../segments/redo-client.js";
import type { QueryCondition, SegmentQuery } from "../segments/redo-types.js";
import type { TranslatedSegment } from "../segments/result-types.js";
import { translateSegment } from "../segments/translate.js";
import { verifySegment } from "../segments/verify.js";

export interface SegmentRunParams {
  klaviyoKey: string;
  redoJwt: string;
  redoServerBase?: string;
  storeId: string;
  storeName: string;
  merchantSlug: string;
  segmentIds: string[];
  aov?: number;
  tolerance?: number;
  listToSegment?: Record<string, string>;
}

// ── metrics cache (per Klaviyo key, 5 min) ──────────────────────────────────
const metricsCache = new Map<string, { at: number; metrics: MetricLookup }>();
async function getMetrics(key: string): Promise<MetricLookup> {
  const hit = metricsCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.metrics;
  const metrics = await fetchAllMetrics(key);
  metricsCache.set(key, { at: Date.now(), metrics });
  return metrics;
}

async function fetchSegmentDetail(key: string, id: string) {
  const detail = await klaviyo(
    `/segments/${id}/?additional-fields%5Bsegment%5D=definition,profile_count`,
    key,
  );
  const attrs = detail.data?.attributes ?? {};
  return {
    id: detail.data?.id ?? id,
    name: (attrs.name as string) ?? null,
    definition: attrs.definition ?? null,
    profileCount: (attrs.profile_count as number) ?? null,
  };
}

// ── list (fast: no per-segment definition fetch) ────────────────────────────
export async function listSegments(key: string): Promise<
  Array<{ id: string; name: string | null; conditionCount: number }>
> {
  const segments = await paginate("/segments/", key);
  return (segments as any[]).map((s) => ({
    id: s.id,
    name: s.attributes?.name ?? null,
    conditionCount: 0, // definition not requested in the list call
  }));
}

// ── preview (translate only; no JWT, no create) ─────────────────────────────
export async function previewSegment(
  key: string,
  segmentId: string,
  aov?: number,
): Promise<{
  name: string;
  importable: boolean;
  partial: boolean;
  klaviyoCount: number | null;
  tiers: { exact: number; substituted: number; unsupported: number };
  substitutions: Array<{ klaviyoSummary: string; redoLogic: string }>;
  dropped: Array<{ klaviyoType: string; dimension?: string; reason: string }>;
}> {
  const metrics = await getMetrics(key);
  const seg = await fetchSegmentDetail(key, segmentId);
  const t = translateSegment(seg, { metrics, aov });
  const total = t.query.conditionBlocks.reduce((n, b) => n + b.conditions.length, 0);
  return {
    name: t.name,
    importable: t.importable,
    partial: t.partial,
    klaviyoCount: t.klaviyoCount,
    tiers: {
      exact: total - t.substitutions.length,
      substituted: t.substitutions.length,
      unsupported: t.dropped.length,
    },
    substitutions: t.substitutions.map((s) => ({
      klaviyoSummary: s.klaviyoSummary,
      redoLogic: s.redoLogic,
    })),
    dropped: t.dropped,
  };
}

// Remove a condition (by object identity) from a query, pruning empty blocks.
function dropCondition(query: SegmentQuery, ref: QueryCondition) {
  for (const block of query.conditionBlocks) {
    block.conditions = block.conditions.filter((c) => c !== ref);
  }
  query.conditionBlocks = query.conditionBlocks.filter((b) => b.conditions.length > 0);
}

function emptyJobSummary(): JobSummary {
  return {
    templatesImported: 0,
    templatesFailed: 0,
    flowsImported: 0,
    flowsFailed: 0,
    campaignsImported: 0,
    campaignsFailed: 0,
    emailsImported: 0,
  };
}

// ── job-backed import ───────────────────────────────────────────────────────
export async function runSegmentImport(
  params: SegmentRunParams,
  ctrl: RunController,
): Promise<JobSummary> {
  const tolerance = params.tolerance ?? 0.1;
  const tolPct = Math.round(tolerance * 100);
  const serverBase = params.redoServerBase;
  let currentJwt = params.redoJwt;
  let jwtRefreshCount = 0;

  // Mirror server.ts withFreshJwt — on 401, prompt for a fresh token and retry.
  async function withFreshJwt<T>(fn: (jwt: string) => Promise<T>, label: string): Promise<T> {
    const MAX = 5;
    for (let attempt = 0; attempt <= MAX; attempt++) {
      try {
        return await fn(currentJwt);
      } catch (e: any) {
        if (!(e instanceof RedoAuthExpiredError)) throw e;
        if (attempt === MAX) throw new Error(`Redo auth still failing after ${MAX} refreshes — ${label}`);
        ctrl.emit({
          kind: "warn",
          text:
            attempt === 0
              ? `Redo session token expired while ${label}. Paste a fresh token to continue.`
              : `That token also failed. Paste another to continue ${label}.`,
        });
        const fresh = await ctrl.prompt({
          questionKey: `redo-jwt-refresh-${++jwtRefreshCount}`,
          question: "Your Redo session token has expired. Paste a fresh JWT to resume.",
          context:
            "Sign in to redo.com in another tab, then copy redo.merchant_auth_token.<teamId> from DevTools → Application → Local Storage.",
          type: "text",
          default: "",
          itemLabel: "Redo session token",
          hideApplyAll: true,
        });
        const trimmed = (fresh ?? "").trim();
        if (!trimmed || trimmed === "__skip__") throw new Error(`Redo token refresh skipped — ${label}`);
        currentJwt = trimmed;
        ctrl.emit({ kind: "info", text: "Token refreshed. Retrying…" });
      }
    }
    throw new Error("withFreshJwt: unreachable");
  }

  const metrics = await getMetrics(params.klaviyoKey);
  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const segmentId of params.segmentIds) {
    let seg: Awaited<ReturnType<typeof fetchSegmentDetail>>;
    try {
      seg = await fetchSegmentDetail(params.klaviyoKey, segmentId);
    } catch (e: any) {
      failed++;
      ctrl.emit({ kind: "segment_failed", id: segmentId, name: segmentId, error: e?.message ?? String(e) });
      continue;
    }
    const name = seg.name ?? segmentId;
    ctrl.emit({ kind: "segment_start", id: segmentId, name, profileCount: seg.profileCount });

    const t: TranslatedSegment = translateSegment(seg, {
      metrics,
      aov: params.aov,
      listToSegment: params.listToSegment,
    });
    const totalConds = t.query.conditionBlocks.reduce((n, b) => n + b.conditions.length, 0);
    ctrl.emit({
      kind: "segment_translated",
      id: segmentId,
      name,
      importable: t.importable,
      partial: t.partial,
      exact: totalConds - t.substitutions.length,
      substituted: t.substitutions.length,
      dropped: t.dropped.length,
      droppedList: t.dropped,
    });

    if (!t.importable) {
      skipped++;
      ctrl.emit({ kind: "segment_skipped", id: segmentId, name, reason: "every condition was unsupported" });
      continue;
    }

    // ── substitution approvals (one boolean per substitution) ──
    for (let i = 0; i < t.substitutions.length; i++) {
      const sub = t.substitutions[i];
      const ans = await ctrl.prompt({
        questionKey: `sub:${segmentId}:${i}`,
        question: `Substitute "${sub.klaviyoSummary}"?`,
        context: `Redo has no native equivalent. Proposed logic: ${sub.redoLogic}. The audience size will be checked against Klaviyo (±${tolPct}%) before import.`,
        type: "boolean",
        default: "true",
        trueLabel: "Use substitute",
        falseLabel: "Drop this condition",
        itemId: segmentId,
        itemLabel: name,
        hideApplyAll: true,
      });
      if (ans !== "true") {
        dropCondition(t.query, sub.conditionRef);
        t.substitutions.splice(i, 1);
        i--;
        ctrl.emit({ kind: "info", itemId: segmentId, text: `Dropped substituted condition: ${sub.klaviyoSummary}` });
      }
    }

    if (t.query.conditionBlocks.length === 0) {
      skipped++;
      ctrl.emit({ kind: "segment_skipped", id: segmentId, name, reason: "all substitutions were declined" });
      continue;
    }

    // ── verify population ──
    let v;
    try {
      v = await withFreshJwt(
        (jwt) => verifySegment(t, { jwt, serverBase, tolerance, autoTune: true }),
        `verifying "${name}"`,
      );
    } catch (e: any) {
      failed++;
      ctrl.emit({ kind: "segment_failed", id: segmentId, name, error: `count check failed: ${e?.message ?? e}` });
      continue;
    }
    ctrl.emit({
      kind: "segment_verified",
      id: segmentId,
      name,
      klaviyoCount: v.klaviyoCount,
      redoCount: v.redoCount,
      deltaPct: v.deltaPct,
      withinTolerance: v.withinTolerance,
      tuned: v.tuned,
      counts: v.counts,
    });

    if (v.withinTolerance === false) {
      const pct = v.deltaPct == null ? "?" : `${(v.deltaPct * 100).toFixed(1)}%`;
      const ans = await ctrl.prompt({
        questionKey: `tol:${segmentId}`,
        question: `Audience size is off by ${pct} — import anyway?`,
        context: `Redo would select ${v.redoCount.toLocaleString()} customers; Klaviyo's segment has ${v.klaviyoCount?.toLocaleString() ?? "?"}. The substitution didn't reproduce the original audience within ±${tolPct}%. Import and refine in Redo, or skip.`,
        type: "boolean",
        default: "false",
        trueLabel: "Import anyway",
        falseLabel: "Skip this segment",
        itemId: segmentId,
        itemLabel: name,
        hideApplyAll: true,
      });
      if (ans !== "true") {
        skipped++;
        ctrl.emit({ kind: "segment_skipped", id: segmentId, name, reason: `outside ±${tolPct}% — declined` });
        continue;
      }
    }

    // ── create ──
    try {
      const c = await withFreshJwt(
        (jwt) => createDynamicSegment(name, t.query, { jwt, serverBase }),
        `creating "${name}"`,
      );
      created++;
      ctrl.emit({
        kind: "segment_created",
        id: segmentId,
        name,
        redoId: c.id,
        redoCount: v.redoCount,
        partial: t.partial,
      });
    } catch (e: any) {
      failed++;
      ctrl.emit({ kind: "segment_failed", id: segmentId, name, error: e?.message ?? String(e) });
    }
  }

  ctrl.emit({ kind: "done", segmentsCreated: created, segmentsSkipped: skipped, segmentsFailed: failed });
  return emptyJobSummary();
}

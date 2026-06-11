// Verify a translated segment against Klaviyo's own member count before import.
//
// getSegmentCount evaluates the candidate query server-side WITHOUT persisting,
// so we can compare Redo's population to Klaviyo's profile_count and gate at
// ±tolerance (default 10%). For count-threshold substitutions (CLV order-count,
// churn inactivity-days) we binary-search the knob to land on Klaviyo's
// population — the rough proxy becomes empirically calibrated.

import type { Substitution, TranslatedSegment } from "./result-types.js";
import type { CustomerActivityCondition } from "./redo-types.js";
import { getSegmentCount, type RedoClientOptions, type SegmentCounts } from "./redo-client.js";

export interface VerifyOptions extends RedoClientOptions {
  /** Acceptable |redo - klaviyo| / klaviyo. Default 0.10. */
  tolerance?: number;
  /** Auto-tune a single tunable substitution to hit tolerance. Default true. */
  autoTune?: boolean;
  /** Max getSegmentCount calls spent tuning. Default 10. */
  maxProbes?: number;
}

export interface TuneRecord {
  summary: string; // human: which substitution, from → to
  from: number;
  to: number;
}

export interface VerifyResult {
  klaviyoCount: number | null;
  redoCount: number;
  counts: SegmentCounts;
  tolerance: number;
  /** null when there's no Klaviyo count to compare against. */
  deltaPct: number | null;
  withinTolerance: boolean | null;
  tuned: TuneRecord[];
  /** Probe count (getSegmentCount calls). */
  probes: number;
}

function pctDelta(value: number, target: number): number {
  return Math.abs(value - target) / Math.max(target, 1);
}

// A tunable knob: read/write an integer on a substitution's condition, plus the
// sign of dPopulation/dKnob (so the search knows which way to move).
interface Knob {
  get(): number;
  set(v: number): void;
  min: number;
  max: number;
  /** -1 if increasing the knob shrinks the population, +1 if it grows it. */
  direction: -1 | 1;
  label: (v: number) => string;
}

function knobFor(sub: Substitution): Knob | null {
  const cond = sub.conditionRef as CustomerActivityCondition;
  if (sub.tunable === "order-count") {
    const op = cond.count?.operator;
    // Monotonic only for threshold operators; eq/neq aren't.
    const direction: -1 | 1 | 0 =
      op === "gte" || op === "gt" ? -1 : op === "lte" || op === "lt" ? 1 : 0;
    if (direction === 0) return null;
    return {
      get: () => cond.count.value,
      set: (v) => { cond.count.value = v; },
      min: 0,
      max: 100,
      direction,
      label: (v) => `${v} orders`,
    };
  }
  if (sub.tunable === "churn-days") {
    const tf = cond.timeframe;
    if (tf.type !== "before-now-relative") return null;
    // "zero orders in last N days": larger N → smaller population.
    return {
      get: () => tf.options.value,
      set: (v) => { tf.options.value = v; },
      min: 1,
      max: 730,
      direction: -1,
      label: (v) => `${v} days`,
    };
  }
  return null;
}

export async function verifySegment(
  translated: TranslatedSegment,
  opts: VerifyOptions,
): Promise<VerifyResult> {
  const tolerance = opts.tolerance ?? 0.1;
  const autoTune = opts.autoTune ?? true;
  const maxProbes = opts.maxProbes ?? 10;
  const target = translated.klaviyoCount;

  let probes = 0;
  const measure = async (): Promise<SegmentCounts> => {
    probes++;
    return getSegmentCount(translated.query, opts);
  };

  let counts = await measure();
  const tuned: TuneRecord[] = [];

  // No Klaviyo baseline → can't gate; just report Redo's count.
  if (target == null) {
    return {
      klaviyoCount: null,
      redoCount: counts.allCount,
      counts,
      tolerance,
      deltaPct: null,
      withinTolerance: null,
      tuned,
      probes,
    };
  }

  let delta = pctDelta(counts.allCount, target);

  // Auto-tune one knob if we're out of tolerance. Only when exactly one tunable
  // substitution exists — multiple knobs interact and aren't safe to search 1-D.
  if (autoTune && delta > tolerance) {
    const tunables = translated.substitutions.filter((s) => knobFor(s) !== null);
    if (tunables.length === 1) {
      const sub = tunables[0];
      const knob = knobFor(sub)!;
      const before = knob.get();
      const result = await searchKnob(knob, target, tolerance, maxProbes - probes, measure);
      counts = result.counts;
      probes = result.probes + probes;
      delta = pctDelta(counts.allCount, target);
      if (knob.get() !== before) {
        tuned.push({
          summary: `${sub.klaviyoSummary} → ${knob.label(knob.get())}`,
          from: before,
          to: knob.get(),
        });
        sub.redoLogic = `${sub.redoLogic.replace(/ \(tuned.*\)$/, "")} (tuned to ${knob.label(knob.get())} to match Klaviyo's ${target.toLocaleString()} members)`;
      }
    }
  }

  return {
    klaviyoCount: target,
    redoCount: counts.allCount,
    counts,
    tolerance,
    deltaPct: delta,
    withinTolerance: delta <= tolerance,
    tuned,
    probes,
  };
}

// Bracket the target then binary-search the integer knob. `measure` re-reads the
// (already-mutated) query, so set the knob before each measure call.
async function searchKnob(
  knob: Knob,
  target: number,
  tolerance: number,
  budget: number,
  measure: () => Promise<SegmentCounts>,
): Promise<{ counts: SegmentCounts; probes: number }> {
  let probes = 0;
  const cache = new Map<number, number>();
  const at = async (v: number): Promise<{ counts: SegmentCounts; count: number }> => {
    knob.set(v);
    const counts = await measure();
    probes++;
    cache.set(v, counts.allCount);
    return { counts, count: counts.allCount };
  };

  // Express everything as: increasing `v` moves population in `knob.direction`.
  // Find lo/hi that bracket the target population.
  let lo = knob.min;
  let hi = knob.max;
  let best = await at(clamp(knob.get(), lo, hi));
  let bestV = knob.get();
  let bestDelta = pctDelta(best.count, target);

  // Walk a coarse scan to bracket, respecting the probe budget.
  const remaining = () => budget - probes;
  while (remaining() > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await at(mid);
    const d = pctDelta(r.count, target);
    if (d < bestDelta) {
      bestDelta = d;
      best = r;
      bestV = mid;
    }
    if (d <= tolerance) break;
    // population(mid) too high or too low?
    const tooHigh = r.count > target;
    // If increasing v shrinks population (direction -1): to lower population, go higher.
    if (knob.direction === -1) {
      if (tooHigh) lo = mid + 1;
      else hi = mid - 1;
    } else {
      if (tooHigh) hi = mid - 1;
      else lo = mid + 1;
    }
    if (lo > hi) break;
  }

  knob.set(bestV);
  // Ensure the final measured state matches bestV.
  const finalCounts =
    cache.has(bestV) && bestV === knob.get()
      ? best.counts
      : (await at(bestV)).counts;
  return { counts: finalCounts, probes };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

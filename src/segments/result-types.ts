// Shared result envelope for segment translation.

import type { QueryCondition, SegmentQuery } from "./redo-types.js";

export type Tier = "exact" | "substituted" | "unsupported";

// What an auto-tunable substitution lets verify.ts adjust to hit the count
// tolerance. The referenced condition object lives inside the SegmentQuery, so
// mutating it (count.value / timeframe.options.value) mutates the query.
export type TuneKind = "order-count" | "churn-days" | null;

export interface Substitution {
  klaviyoType: string; // e.g. "profile-predictive-analytics"
  klaviyoSummary: string; // human: "predicted CLV ≥ 500"
  redoLogic: string; // human: "customers with ≥ 5 orders all-time (AOV $100)"
  assumptions: { aov?: number };
  tunable: TuneKind;
  /** The condition object inside the query that verify may mutate when tuning. */
  conditionRef: QueryCondition;
}

export interface Dropped {
  klaviyoType: string;
  dimension?: string;
  reason: string;
}

// Per-condition translation outcome.
export type CondResult =
  | { kind: "exact"; condition: QueryCondition }
  | { kind: "substituted"; condition: QueryCondition; sub: Substitution }
  | { kind: "unsupported"; dropped: Dropped };

export interface TranslatedSegment {
  klaviyoId: string;
  name: string;
  klaviyoCount: number | null;
  query: SegmentQuery;
  substitutions: Substitution[];
  dropped: Dropped[];
  /** True only if at least one condition survived translation. */
  importable: boolean;
  /** True if any block lost conditions (dropped) — the imported segment is
   *  narrower/wider than the original even if it imports. */
  partial: boolean;
}

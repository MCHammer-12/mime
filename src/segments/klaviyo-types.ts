// Klaviyo segment `definition` shapes, as returned by
//   GET /api/segments/{id}?additional-fields[segment]=definition
// and accepted by POST /api/segments.
//
// Structure: condition_groups[] are joined by AND; conditions[] within a
// group are joined by OR. (Klaviyo Segments API overview.)
//
// These are intentionally loose (optional fields, `string` operators) — the
// live API has drifted field names before (cf. the flow `tf.quantity` vs
// `tf.value` saga in src/flow/condition-mapping.ts), so the translator reads
// defensively rather than trusting a tight type.

export interface KlaviyoSegmentList {
  id: string;
  name: string | null;
  created: string | null;
  updated: string | null;
  profileCount: number | null;
}

export interface KlaviyoSegmentDefinition {
  condition_groups?: KlaviyoConditionGroup[];
}

export interface KlaviyoConditionGroup {
  conditions?: KlaviyoCondition[];
}

export type KlaviyoCondition =
  | ProfilePropertyCondition
  | ProfileMetricCondition
  | ProfileGroupMembershipCondition
  | ProfileMarketingConsentCondition
  | ProfilePredictiveAnalyticsCondition
  | ProfileRegionCondition
  | ProfilePostalCodeDistanceCondition
  | { type: string; [k: string]: unknown };

export interface KlaviyoFilter {
  type?: "string" | "numeric" | "boolean" | "date" | string;
  operator?: string;
  value?: unknown;
  // date `in-the-last` shape
  quantity?: number;
  unit?: string;
}

export interface ProfilePropertyCondition {
  type: "profile-property";
  property: string;
  filter?: KlaviyoFilter;
}

export interface ProfileMetricCondition {
  type: "profile-metric";
  metric_id: string;
  measurement?: string; // "count" | "sum" | "value" | ...
  measurement_filter?: KlaviyoFilter;
  timeframe_filter?: KlaviyoFilter;
  metric_filters?: Array<{ property: string; filter?: KlaviyoFilter }>;
}

export interface ProfileGroupMembershipCondition {
  type: "profile-group-membership";
  is_member?: boolean;
  group_ids?: string[];
  timeframe_filter?: KlaviyoFilter;
}

export interface ProfileMarketingConsentCondition {
  type: "profile-marketing-consent";
  consent?: {
    channel?: "email" | "sms" | "push" | string;
    can_receive_marketing?: boolean;
    consent_status?: { subscription?: string; filters?: unknown[] };
  };
}

export interface ProfilePredictiveAnalyticsCondition {
  type: "profile-predictive-analytics";
  dimension: string; // average_order_value | predicted_clv | churn_probability | ...
  filter?: KlaviyoFilter;
}

export interface ProfileRegionCondition {
  type: "profile-region";
  in_region?: boolean;
  region_id?: string; // european_union | united_states | ...
}

export interface ProfilePostalCodeDistanceCondition {
  type: "profile-postal-code-distance";
  country_code?: string;
  postal_code?: string;
  unit?: string;
  filter?: KlaviyoFilter;
}

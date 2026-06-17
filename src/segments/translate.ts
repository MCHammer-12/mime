// Klaviyo segment `definition` → Redo SegmentQuery.
//
// Tiers (see result-types.ts): exact (direct map), substituted (proxy + "here's
// our logic" + must clear the ±10% count check), unsupported (dropped, warned).
//
// Structural map: Klaviyo condition_groups are AND'd, conditions within a group
// are OR'd → Redo `{ conjunction:"AND", conditionBlocks:[{operator:"OR", ...}] }`.

import type { MetricLookup } from "../extract-metrics.js";
import type {
  KlaviyoCondition,
  KlaviyoSegmentList,
  ProfileGroupMembershipCondition,
  ProfileMarketingConsentCondition,
  ProfileMetricCondition,
  ProfilePostalCodeDistanceCondition,
  ProfilePredictiveAnalyticsCondition,
  ProfilePropertyCondition,
  ProfileRegionCondition,
} from "./klaviyo-types.js";
import {
  ACTIVITY_VALUE_DIMENSION,
  countFrom,
  KLAVIYO_NUMERIC_OP_TO_REDO,
  KLAVIYO_STRING_OP_TO_REDO,
  mapMetricFilter,
  METRIC_EXPLICIT_DROP,
  METRIC_TO_ACTIVITY,
  timeframeFrom,
  VALUE_MEASUREMENTS,
} from "./maps.js";
import type { CondResult, Dropped, Substitution, TranslatedSegment } from "./result-types.js";
import type {
  ConditionBlock,
  CustomerActivityType,
  QueryCondition,
  SegmentQuery,
  Timeframe,
  TokenOperator,
  WhereCondition,
} from "./redo-types.js";
import {
  substituteLapsed,
  substitutePostalCodeDistance,
  substitutePredictiveAnalytics,
  substituteRegion,
  type SubstitutionOptions,
} from "./substitutions.js";

export interface TranslateContext {
  metrics: MetricLookup;
  /** Merchant AOV for CLV→order-count substitution (auto-tuned later). */
  aov?: number;
  /** Klaviyo list/segment id → existing Redo static-segment id, for
   *  group-membership conditions. Populated as segments are imported in
   *  dependency order, or supplied by the operator. */
  listToSegment?: Record<string, string>;
}

// Common country-name → ISO-3166-1 alpha-2 for $country profile properties.
// Klaviyo stores the full name; Redo's `country` dimension keys on ISO codes.
const COUNTRY_NAME_TO_ISO: Record<string, string> = {
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  canada: "CA",
  "united kingdom": "GB",
  uk: "GB",
  australia: "AU",
  germany: "DE",
  france: "FR",
  spain: "ES",
  italy: "IT",
  netherlands: "NL",
  ireland: "IE",
  "new zealand": "NZ",
  mexico: "MX",
  japan: "JP",
  sweden: "SE",
  norway: "NO",
  denmark: "DK",
  finland: "FI",
  belgium: "BE",
  austria: "AT",
  switzerland: "CH",
  portugal: "PT",
  poland: "PL",
  brazil: "BR",
  india: "IN",
  "south africa": "ZA",
  singapore: "SG",
};

const PHONE_COUNTRY_OPS: Record<string, TokenOperator> = {
  "phone-country-code-in": "ANY",
  "phone-country-code-not-in": "NONE",
};

function unsupported(d: Dropped): CondResult {
  return { kind: "unsupported", dropped: d };
}

// ---- profile-property ------------------------------------------------------

function translateProfileProperty(c: ProfilePropertyCondition): CondResult {
  const prop = (c.property ?? "").toLowerCase().replace(/^\$/, "");
  const op = c.filter?.operator;
  const rawVal = c.filter?.value;

  // Phone country code (operator carries the intent), → profile country.
  if (op && PHONE_COUNTRY_OPS[op]) {
    const values = normalizeCountryCodes(rawVal);
    if (values.length === 0)
      return unsupported({ klaviyoType: "profile-property", dimension: prop, reason: "phone-country-code with no values" });
    const condition = tokenAttr("country", PHONE_COUNTRY_OPS[op], values);
    return {
      kind: "substituted",
      condition,
      sub: {
        klaviyoType: "profile-property",
        klaviyoSummary: `phone country ${op} ${values.join(",")}`,
        redoLogic: `profile country ${PHONE_COUNTRY_OPS[op] === "NONE" ? "is none of" : "is any of"} ${values.join(", ")}`,
        assumptions: {},
        tunable: null,
        conditionRef: condition,
      },
    };
  }

  if (prop === "email") {
    const sop = op ? KLAVIYO_STRING_OP_TO_REDO[op] : undefined;
    const value = String(rawVal ?? "");
    if (sop) {
      return { kind: "exact", condition: stringAttr("email-address", sop, value) };
    }
    if (op === "equals") {
      // Redo string conditions have no exact-equals operator → degrade to a
      // contains match on the full address (overshoots only on substrings).
      const condition = stringAttr("email-address", "contains", value);
      return {
        kind: "substituted",
        condition,
        sub: {
          klaviyoType: "profile-property",
          klaviyoSummary: `email equals ${value}`,
          redoLogic: `email contains "${value}" (Redo has no exact-equals string op)`,
          assumptions: {},
          tunable: null,
          conditionRef: condition,
        },
      };
    }
    return unsupported({ klaviyoType: "profile-property", dimension: "email", reason: `email operator "${op}" not translatable` });
  }

  if (prop === "country") {
    const tok = op === "not-equals" || op === "does-not-equal" ? "NONE" : "ANY";
    const iso = COUNTRY_NAME_TO_ISO[String(rawVal ?? "").toLowerCase()];
    if (!iso)
      return unsupported({ klaviyoType: "profile-property", dimension: "country", reason: `country value "${rawVal}" has no ISO-code mapping` });
    return { kind: "exact", condition: tokenAttr("country", tok, [iso]) };
  }

  if (prop === "region" || prop === "state") {
    // Klaviyo $region carries no country; Redo state-province is a hierarchy
    // under a country prerequisite. Assume US (the common case) and flag it.
    const tok = op === "not-equals" ? "NONE" : "ANY";
    const stateVal = String(rawVal ?? "").trim();
    if (!stateVal)
      return unsupported({ klaviyoType: "profile-property", dimension: "region", reason: "empty state value" });
    const condition: QueryCondition = {
      type: "customer_attribute",
      whereCondition: {
        type: "token-hierarchy",
        dimension: "state-province",
        comparison: { type: "token", operator: tok, prerequisiteValues: ["US"], values: [stateVal] },
      },
    };
    return {
      kind: "substituted",
      condition,
      sub: {
        klaviyoType: "profile-property",
        klaviyoSummary: `state ${op} ${stateVal}`,
        redoLogic: `state ${tok === "NONE" ? "is not" : "is"} "${stateVal}" (assumed country US)`,
        assumptions: {},
        tunable: null,
        conditionRef: condition,
      },
    };
  }

  if (prop === "created") {
    // Profile created date → created-time (full date).
    return { kind: "exact", condition: dateAttr("created-time", timeframeFrom(c.filter)) };
  }

  if (prop === "first_name" || prop === "last_name") {
    // Redo has only a full `customer-name` string field.
    const value = String(rawVal ?? "");
    const condition = stringAttr("customer-name", "contains", value);
    return {
      kind: "substituted",
      condition,
      sub: {
        klaviyoType: "profile-property",
        klaviyoSummary: `${prop} ${op} ${value}`,
        redoLogic: `customer name contains "${value}" (Redo has only a full-name field)`,
        assumptions: {},
        tunable: null,
        conditionRef: condition,
      },
    };
  }

  if (prop === "birthday") {
    return { kind: "exact", condition: dateAttr("birthday", timeframeFrom(c.filter), true) };
  }

  if (prop === "last_active") {
    // No Redo last-activity dim → lapsed-buyer proxy (resolved 2026-06-16).
    return substituteLapsed("profile-property", `last_active ${op ?? ""}`.trim());
  }

  if (prop === "city") {
    // Redo city is a hierarchy under country+state; we only have the city.
    // Assume US (resolved 2026-06-16) — operator sets the state in Redo if needed.
    const tok = op === "not-equals" ? "NONE" : "ANY";
    const cityVal = String(rawVal ?? "").trim();
    if (!cityVal)
      return unsupported({ klaviyoType: "profile-property", dimension: "city", reason: "empty city value" });
    const condition: QueryCondition = {
      type: "customer_attribute",
      whereCondition: {
        type: "token-hierarchy",
        dimension: "city",
        comparison: { type: "token", operator: tok, prerequisiteValues: ["US"], values: [cityVal] },
      },
    };
    return {
      kind: "substituted",
      condition,
      sub: {
        klaviyoType: "profile-property",
        klaviyoSummary: `city ${op} ${cityVal}`,
        redoLogic: `city ${tok === "NONE" ? "is not" : "is"} "${cityVal}" (assumed US; set the state in Redo if ambiguous)`,
        assumptions: {},
        tunable: null,
        conditionRef: condition,
      },
    };
  }

  // Properties with no Redo target (and not a definable custom field) — give a
  // precise reason rather than the generic custom-field fallback.
  const reason = EXPLICIT_UNSUPPORTED[prop];
  if (reason) return unsupported({ klaviyoType: "profile-property", dimension: prop, reason });

  // Anything else (custom profile properties, etc.) needs team-level custom-field
  // setup we can't infer.
  return unsupported({
    klaviyoType: "profile-property",
    dimension: prop,
    reason: `profile property "${c.property}" maps to a Redo custom field that must be defined on the team first.`,
  });
}

const EXPLICIT_UNSUPPORTED: Record<string, string> = {
  zip: "Redo has no postal-code characteristic",
  postal_code: "Redo has no postal-code characteristic",
  timezone: "Redo has no timezone characteristic",
  locale: "Redo has no locale characteristic",
  organization: "Redo has no organization characteristic",
  title: "Redo has no title characteristic",
  updated: "Redo tracks only created-time, not last-updated",
  source: "Redo has no acquisition-source characteristic",
  image: "not a segmentation field",
  address1: "Redo has no street-address characteristic",
  address2: "Redo has no street-address characteristic",
  latitude: "Redo has no latitude/longitude characteristic",
  longitude: "Redo has no latitude/longitude characteristic",
  phone_number: "Redo can match phone area code only, not full phone numbers",
};

// ---- profile-metric --------------------------------------------------------

function translateProfileMetric(
  c: ProfileMetricCondition,
  ctx: TranslateContext,
): CondResult {
  const metric = ctx.metrics[c.metric_id];
  if (!metric)
    return unsupported({ klaviyoType: "profile-metric", reason: `unknown metric id ${c.metric_id}` });
  const name = metric.name.toLowerCase();

  // Unsubscribed-email event → current unsubscribed state (resolved 2026-06-16).
  if (name === "unsubscribed" || name === "unsubscribed email" || name === "unsubscribed from email") {
    const condition: QueryCondition = {
      type: "customer_attribute",
      whereCondition: { type: "boolean", dimension: "subscribed-to-email", comparison: { type: "boolean", value: false } },
    };
    return {
      kind: "substituted",
      condition,
      sub: {
        klaviyoType: "profile-metric",
        klaviyoSummary: `${metric.name} event`,
        redoLogic: "subscribed-to-email = false (current state; the event timeframe is dropped)",
        assumptions: {},
        tunable: null,
        conditionRef: condition,
      },
    };
  }

  const activity = METRIC_TO_ACTIVITY[name] as CustomerActivityType | undefined;
  if (!activity) {
    const reason = METRIC_EXPLICIT_DROP[name] ?? `metric "${metric.name}" has no Redo activity equivalent`;
    return unsupported({ klaviyoType: "profile-metric", dimension: metric.name, reason });
  }

  const measurement = String(c.measurement ?? "count").toLowerCase();
  const op = c.measurement_filter?.operator;
  const value = Number(c.measurement_filter?.value ?? 0);
  const timeframe = timeframeFrom(c.timeframe_filter);

  // Translate Klaviyo event-property filters → Redo event_filters.
  const eventFilters: WhereCondition[] = [];
  let droppedFilters = 0;
  for (const mf of c.metric_filters ?? []) {
    const wc = mapMetricFilter(activity, mf.property, mf.filter);
    if (wc) eventFilters.push(wc);
    else droppedFilters++;
  }
  const dropNote = droppedFilters > 0 ? ` (${droppedFilters} property filter(s) had no Redo field — segment will be broader)` : "";

  // Value measurement (sum of $value) → at-least-once + numeric event_filter.
  if (VALUE_MEASUREMENTS.has(measurement)) {
    const dimension = ACTIVITY_VALUE_DIMENSION[activity];
    const redoOp = op ? KLAVIYO_NUMERIC_OP_TO_REDO[op] : undefined;
    if (!dimension || !redoOp)
      return unsupported({ klaviyoType: "profile-metric", dimension: metric.name, reason: `value measurement on "${metric.name}" has no Redo value dimension` });
    eventFilters.unshift({ type: "numeric", dimension, comparison: { type: "numeric", operator: redoOp, value } });
    const condition: QueryCondition = {
      type: "customer_activity",
      event: activity,
      count: { operator: "gt", value: 0 },
      timeframe,
      event_filters: eventFilters,
    };
    return {
      kind: "substituted",
      condition,
      sub: {
        klaviyoType: "profile-metric",
        klaviyoSummary: `${metric.name} value ${op} ${value}`,
        redoLogic: `${activity} with ${dimension} ${redoOp} ${value} (Klaviyo sums over the window; Redo matches per-event)${dropNote}`,
        assumptions: {},
        tunable: null,
        conditionRef: condition,
      },
    };
  }

  if (measurement !== "count")
    return unsupported({ klaviyoType: "profile-metric", dimension: metric.name, reason: `measurement "${measurement}" not supported` });

  const condition: QueryCondition = {
    type: "customer_activity",
    event: activity,
    count: countFrom(op, value),
    timeframe,
    event_filters: eventFilters,
  };
  // Clean count, all filters mapped → exact. Dropped filters → broader → flag.
  if (droppedFilters > 0) {
    return {
      kind: "substituted",
      condition,
      sub: {
        klaviyoType: "profile-metric",
        klaviyoSummary: `${metric.name} count`,
        redoLogic: `${activity} count with ${eventFilters.length} filter(s)${dropNote}`,
        assumptions: {},
        tunable: null,
        conditionRef: condition,
      },
    };
  }
  return { kind: "exact", condition };
}

// ---- profile-group-membership ----------------------------------------------

function translateGroupMembership(
  c: ProfileGroupMembershipCondition,
  ctx: TranslateContext,
): CondResult {
  const ids = c.group_ids ?? [];
  const mapped = ids.map((id) => ctx.listToSegment?.[id]).filter((x): x is string => !!x);
  if (mapped.length === 0 || mapped.length !== ids.length) {
    return unsupported({
      klaviyoType: "profile-group-membership",
      reason: `references Klaviyo list(s) [${ids.join(",")}] with no Redo segment mapping — recreate the list/segment in Redo first, then map it.`,
    });
  }
  const op: TokenOperator = c.is_member === false ? "NONE" : "ANY";
  return {
    kind: "exact",
    condition: {
      type: "customer_attribute",
      whereCondition: {
        type: "token_list",
        dimension: "static-segment-membership",
        comparison: { type: "list", operator: op === "NONE" ? "none" : "any", values: mapped },
      },
    },
  };
}

// ---- profile-marketing-consent ---------------------------------------------

function translateMarketingConsent(c: ProfileMarketingConsentCondition): CondResult {
  const channel = c.consent?.channel;
  const subscription = c.consent?.consent_status?.subscription;
  const canReceive = c.consent?.can_receive_marketing;

  // "Can receive email marketing" (eligibility, not strict opt-in) → Redo's
  // can-receive-email-marketing dimension, when no explicit subscription state
  // is set. Email channel only (Redo has no can-receive-sms dimension).
  if (channel === "email" && (subscription == null || subscription === "any") && canReceive != null) {
    return {
      kind: "exact",
      condition: {
        type: "customer_attribute",
        whereCondition: {
          type: "boolean",
          dimension: "can-receive-email-marketing",
          comparison: { type: "boolean", value: canReceive },
        },
      },
    };
  }

  const dimension =
    channel === "sms" ? "subscribed-to-sms" : channel === "email" ? "subscribed-to-email" : null;
  if (!dimension)
    return unsupported({ klaviyoType: "profile-marketing-consent", dimension: channel, reason: `consent channel "${channel}" not supported` });
  const value = subscription === "subscribed";
  return {
    kind: "exact",
    condition: {
      type: "customer_attribute",
      whereCondition: { type: "boolean", dimension, comparison: { type: "boolean", value } },
    },
  };
}

// ---- dispatch --------------------------------------------------------------

export function translateCondition(c: KlaviyoCondition, ctx: TranslateContext): CondResult {
  const opts: SubstitutionOptions = { aov: ctx.aov };
  switch ((c as { type: string }).type) {
    case "profile-property":
      return translateProfileProperty(c as ProfilePropertyCondition);
    case "profile-metric":
      return translateProfileMetric(c as ProfileMetricCondition, ctx);
    case "profile-group-membership":
      return translateGroupMembership(c as ProfileGroupMembershipCondition, ctx);
    case "profile-marketing-consent":
      return translateMarketingConsent(c as ProfileMarketingConsentCondition);
    case "profile-predictive-analytics":
      return substitutePredictiveAnalytics(c as ProfilePredictiveAnalyticsCondition, opts);
    case "profile-region":
      return substituteRegion(c as ProfileRegionCondition);
    case "profile-postal-code-distance":
      return substitutePostalCodeDistance(c as ProfilePostalCodeDistanceCondition);
    default:
      return unsupported({ klaviyoType: (c as { type: string }).type, reason: `condition type "${(c as { type: string }).type}" not handled` });
  }
}

export function translateSegment(
  segment: { id: string; name: string | null; definition: { condition_groups?: Array<{ conditions?: KlaviyoCondition[] }> } | null; profileCount?: number | null },
  ctx: TranslateContext,
): TranslatedSegment {
  const groups = segment.definition?.condition_groups ?? [];
  const blocks: ConditionBlock[] = [];
  const substitutions: Substitution[] = [];
  const dropped: Dropped[] = [];
  let droppedAny = false;

  for (const group of groups) {
    const conditions: QueryCondition[] = [];
    for (const kc of group.conditions ?? []) {
      const res = translateCondition(kc, ctx);
      if (res.kind === "unsupported") {
        dropped.push(res.dropped);
        droppedAny = true;
        continue;
      }
      conditions.push(res.condition);
      if (res.kind === "substituted") substitutions.push(res.sub);
    }
    // Drop empty blocks — an all-unsupported group would otherwise widen the
    // segment to "everyone" (an empty OR matches nothing, but an empty block
    // is meaningless to Redo's evaluator).
    if (conditions.length > 0) blocks.push({ operator: "OR", conditions });
  }

  const importable = blocks.length > 0;
  return {
    klaviyoId: segment.id,
    name: segment.name ?? segment.id,
    klaviyoCount: segment.profileCount ?? null,
    query: { conjunction: "AND", conditionBlocks: blocks },
    substitutions,
    dropped,
    importable,
    partial: droppedAny && importable,
  };
}

// ---- where-condition builders ----------------------------------------------

function tokenAttr(dimension: string, operator: TokenOperator, values: string[]): QueryCondition {
  return {
    type: "customer_attribute",
    whereCondition: { type: "token", dimension, comparison: { type: "token", operator, values } },
  };
}

function stringAttr(
  dimension: string,
  operator: "contains" | "not_contains" | "starts_with" | "ends_with",
  value: string,
): QueryCondition {
  return {
    type: "customer_attribute",
    whereCondition: { type: "string", dimension, comparison: { type: "string", operator, value } },
  };
}

function dateAttr(dimension: string, comparison: Timeframe, annual = false): QueryCondition {
  return {
    type: "customer_attribute",
    whereCondition: { type: annual ? "date-annual" : "date", dimension, comparison },
  };
}

function normalizeCountryCodes(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
  return parts
    .map((p) => String(p).trim().toUpperCase())
    .filter((p) => /^[A-Z]{2}$/.test(p));
}

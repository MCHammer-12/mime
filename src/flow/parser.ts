import { ObjectId } from "bson";
import type { MetricLookup } from "../extract-metrics.js";
import {
  translateConditionalSplitExpression,
  translateFlowProfileFilter,
  translateTriggerSplitExpression,
} from "./condition-mapping.js";
import type { TemplateResolver } from "./template-resolver.js";
import { treeifyFlow } from "./treeify.js";
import { resolveTrigger, type TriggerResolution } from "./trigger-mapping.js";
import { rewriteKlaviyoLiquid } from "./variable-mapping.js";
import { substituteStringVars } from "../transform.js";
import { formatAddress, type KlaviyoAccount } from "../fetch-account.js";
import {
  SchemaType,
  StepType,
  WaitTimeUnit,
  type AbTestStep,
  type AdvancedFlow,
  type ConditionStep,
  type DoNothingStep,
  type FlowCategory,
  type KlaviyoAction,
  type KlaviyoFlow,
  type ParseResult,
  type ParseWarning,
  type PlaceholderSmsTemplate,
  type PlaceholderTemplate,
  type SendEmailStep,
  type SendSmsStep,
  type SendWebhookStep,
  type Step,
  type TriggerStep,
  type WaitStep,
} from "./types.js";

const TRIGGER_STEP_ID = "trigger";
const FLOW_END_ID = "flow_end";

// Branch pointer may be absent when a Klaviyo action is the last step on its
// path ("end path" in Klaviyo's UI). Redo's mongoose schemas mark several
// pointer fields as `required: true` on String type, and mongoose rejects
// empty strings for required String fields. When we don't have a real
// pointer, route to a single shared terminal DO_NOTHING step at the tail
// of the flow. state.needsTerminal is flipped the first time we generate a
// reference so parseFlow can append the step.
interface ParseState {
  needsTerminal: boolean;
}

function terminate(
  pointer: string | null | undefined,
  state: ParseState,
): string {
  if (pointer && pointer.length > 0) return pointer;
  state.needsTerminal = true;
  return FLOW_END_ID;
}

// Detect Klaviyo's random/weighted split primitive — represented as a
// conditional-split whose first condition_group has a single `profile-sample`
// condition with a `percentage`. Returns that condition (with the percentage)
// when present, otherwise null. Caller emits an AB_TEST step in lieu of a
// regular CONDITION.
function findProfileSample(action: KlaviyoAction): { percentage: number } | null {
  const groups = action.data?.profile_filter?.condition_groups ?? [];
  if (groups.length === 0) return null;
  const conditions = groups[0]?.conditions ?? [];
  if (conditions.length !== 1) return null;
  const c = conditions[0];
  if (c?.type !== "profile-sample") return null;
  const pct = typeof c.percentage === "number" ? c.percentage : Number(c.percentage);
  return { percentage: Number.isFinite(pct) ? pct : 50 };
}

// Mid-flow placeholder for a Klaviyo action we can't translate (send-sms,
// update-profile, ab-test, gnarly send-webhook, etc.). DO_NOTHING is
// terminal-only in Redo's schema (no nextId field), so emitting one with a
// nextId silently breaks the chain — the builder renders everything past
// it as a disconnected island. A 0-duration WAIT keeps the chain intact
// and shows the customTitle so the merchant still sees what was skipped.
function skipStub(
  id: string,
  customTitle: string,
  nextPointer: string | null | undefined,
  state: ParseState,
): WaitStep {
  return {
    type: StepType.WAIT,
    id,
    customTitle,
    numDays: 0,
    numSeconds: 0,
    timeUnit: WaitTimeUnit.MINUTES,
    nextId: terminate(nextPointer, state),
  };
}

function mapWaitTimeUnit(unit: string): WaitTimeUnit {
  switch (unit) {
    case "days":
      return WaitTimeUnit.DAYS;
    case "hours":
      return WaitTimeUnit.HOURS;
    case "minutes":
      return WaitTimeUnit.MINUTES;
    default:
      return WaitTimeUnit.DAYS;
  }
}

// First time-delay action in the Klaviyo flow defines the practical
// "browse abandonment window" — the customer viewed a product N hours/days
// ago and hasn't converted. Used to seed the viewed-product skip condition
// on Viewed Product / Active on Site → Browse Abandonment imports.
// Returns Redo's `before-now-relative` timeframe shape with singular units.
function extractFirstTimeDelayWindow(
  flow: KlaviyoFlow,
): { value: number; units: "minute" | "hour" | "day" } | null {
  const actions = flow.data.attributes.definition?.actions ?? [];
  for (const a of actions) {
    if (a.type !== "time-delay") continue;
    const value = Number(a.data?.value ?? 0);
    if (!Number.isFinite(value) || value <= 0) continue;
    const unit = String(a.data?.unit ?? "hours");
    const units: "minute" | "hour" | "day" =
      unit === "days" ? "day" :
      unit === "minutes" ? "minute" :
      "hour";
    return { value, units };
  }
  return null;
}

/**
 * Sentinel returned by convertAction when the action should be dropped from
 * the flow entirely (no WAIT stub, no placeholder). The caller stitches the
 * predecessor's nextId past the dropped id by recording {droppedId → next}
 * in `dropRedirects` and rewriting all step pointers in a post-pass.
 *
 * Used for actions that have no Redo equivalent and would otherwise leave
 * dead "TODO" placeholders cluttering the imported flow (update-profile,
 * list-update, target-date, etc.). Per merchant feedback (2026-05-05),
 * dropping is preferable to a 0-minute WAIT stub the merchant has to clean
 * up by hand.
 */
const DROP = Symbol("drop");
type DropResult = { [DROP]: true; redirectTo: string };
function dropAction(redirectTo: string): DropResult {
  return { [DROP]: true, redirectTo };
}
function isDropResult(r: unknown): r is DropResult {
  return typeof r === "object" && r !== null && (r as any)[DROP] === true;
}

// Per-action dispatcher. Emits exactly one Redo Step, drops the action with
// re-stitching info, or returns null on hard skip.
// Async because the send-email handler may need to resolve + parse the
// referenced Klaviyo template (HTML → full Redo EmailTemplate JSON).
async function convertAction(
  action: KlaviyoAction,
  metrics: MetricLookup,
  flowSchemaType: SchemaType,
  flowCategory: FlowCategory,
  templateResolver: TemplateResolver | null,
  account: KlaviyoAccount | null,
  warnings: ParseWarning[],
  placeholderTemplates: PlaceholderTemplate[],
  placeholderSmsTemplates: PlaceholderSmsTemplate[],
  state: ParseState,
): Promise<Step | DropResult | null> {
  const id = action.id;
  const next = action.links?.next ?? undefined;

  switch (action.type) {
    case "time-delay": {
      const d = action.data ?? {};
      const unit = mapWaitTimeUnit(d.unit ?? "days");
      const value = Number(d.value ?? 0);
      const step: WaitStep = {
        type: StepType.WAIT,
        id,
        timeUnit: unit,
        numDays: unit === WaitTimeUnit.DAYS ? value : 0,
        numSeconds:
          unit === WaitTimeUnit.HOURS ? value * 3600 :
          unit === WaitTimeUnit.MINUTES ? value * 60 :
          undefined,
        // WAIT step's nextId is mongoose-required; "" would fail validation
        // on a terminal wait. Route orphans to the shared flow_end terminal.
        nextId: terminate(next, state),
      };
      if (d.delay_until_time) {
        warnings.push({
          kind: "degraded-mapping",
          actionId: id,
          message: `time-delay has delay_until_time=${d.delay_until_time}; Redo WAIT has no time-of-day field — delay will fire whenever the ${unit} window elapses`,
        });
      }
      const weekdays: string[] | undefined = d.delay_until_weekdays;
      if (weekdays && weekdays.length > 0 && weekdays.length < 7) {
        warnings.push({
          kind: "degraded-mapping",
          actionId: id,
          message: `time-delay restricted to weekdays [${weekdays.join(",")}]; Redo WAIT has no weekday filter — restriction dropped`,
        });
      }
      if (d.timezone && d.timezone !== "profile") {
        warnings.push({
          kind: "degraded-mapping",
          actionId: id,
          message: `time-delay timezone=${d.timezone} (not "profile"); Redo WAIT timezone support TBD — may fire in server TZ`,
        });
      }
      return step;
    }

    case "send-email": {
      const msg = action.data?.message ?? {};
      const sentinelId = `__PLACEHOLDER_${msg.template_id ?? id}__`;
      let fullTemplate: Record<string, any> | null = null;
      const templateWarnings: string[] = [];
      if (templateResolver && msg.template_id) {
        const resolved = await templateResolver.resolve(msg.template_id);
        if ("failure" in resolved) {
          // Surface the specific reason instead of a generic "not found".
          // Six identical "not found" warnings on a flow that really hit
          // six different parser exceptions hides the real bug (see
          // Goumikids 2026-05-08 troubleshoot bundle).
          const f = resolved.failure;
          warnings.push({
            kind: "requires-review",
            actionId: id,
            message: `send-email references Klaviyo template ${msg.template_id} — emitted blank placeholder. Reason: ${f.reason} (${f.detail})`,
          });
          templateWarnings.push(
            `Resolver failed (${f.reason}): ${f.detail}`,
          );
        } else {
          fullTemplate = resolved.template;
          templateWarnings.push(...resolved.warnings);
          // Carry through per-step metadata onto the template so the
          // importer uses Klaviyo's subject/from/preview instead of the
          // HTML parser's defaults. Run org / shop / customer-profile
          // substitutions on subject + preview — Klaviyo subjects routinely
          // use {{ organization.name }} / {{ first_name }} which Redo's
          // runtime doesn't resolve.
          const subVarCtx = {
            orgName: account?.organizationName ?? "",
            orgAddress: account ? formatAddress(account) : "",
            orgUrl: account?.websiteUrl ?? "",
          };
          if (msg.subject_line) {
            fullTemplate.subject = substituteStringVars(msg.subject_line, subVarCtx);
          }
          if (msg.preview_text) {
            fullTemplate.emailPreview = substituteStringVars(msg.preview_text, subVarCtx);
          }
        }
      }
      // Substitution context (mirrors the fullTemplate branch above) so
      // {{ first_name }} / {{ organization.name }} in the action-level
      // subject/preview gets rewritten before it lands in Redo. Without
      // this the importer prefers the raw `subject` over the substituted
      // `fullTemplate.subject` (see import-rpc.ts), so a subject like
      // "Thank you {{ first_name|default:'' }} :)" would ship literal.
      const phSubVarCtx = {
        orgName: account?.organizationName ?? "",
        orgAddress: account ? formatAddress(account) : "",
        orgUrl: account?.websiteUrl ?? "",
      };
      const phSubject = msg.subject_line
        ? substituteStringVars(msg.subject_line, phSubVarCtx)
        : "";
      const phPreview = msg.preview_text
        ? substituteStringVars(msg.preview_text, phSubVarCtx)
        : null;
      placeholderTemplates.push({
        sentinelId,
        klaviyoTemplateId: msg.template_id ?? null,
        subject: phSubject,
        fromEmail: msg.from_email ?? null,
        fromLabel: msg.from_label ?? null,
        previewText: phPreview,
        fullTemplate,
        templateWarnings,
      });
      // Trailing send-emails need an End-of-flow terminal after them so the
      // builder renders an End block; route orphan pointers to flow_end.
      // Leave `disabled` unset — flow-level `enabled` is the single on/off
      // knob the merchant flips after review.
      const step: SendEmailStep = {
        type: StepType.SEND_EMAIL,
        id,
        templateId: sentinelId,
        emailAddressFieldName: "customerEmail",
        recipientNameFieldName: "customerFullName",
        nextId: terminate(next, state),
      };
      if (msg.smart_sending_enabled === false) {
        // Flag for the importer to set shouldSkipSmartSending on the TRIGGER step
        // (Redo can only toggle smart-sending at the trigger level). Warn so we
        // don't silently flip flow-wide behaviour.
        warnings.push({
          kind: "requires-review",
          actionId: id,
          message: `send-email has smart_sending_enabled: false; Redo only supports this flow-wide via trigger.shouldSkipSmartSending — review before enabling`,
        });
      }
      if (msg.transactional === true) {
        warnings.push({
          kind: "requires-review",
          actionId: id,
          message: `send-email marked transactional — verify Redo send path supports bypass of unsubscribe from automation context`,
        });
      }
      return step;
    }

    case "send-sms": {
      // Klaviyo send-sms → real Redo SendSmsStep + a placeholder SmsTemplate
      // queued for createSmsTemplate at import time. Body Liquid is rewritten
      // through the same translator we use for webhooks (Klaviyo customer /
      // event vars → Redo schema-instance vars).
      const msg = action.data?.message ?? {};
      const rawBody = String(msg.body ?? "");
      const bodyResult = rewriteKlaviyoLiquid(rawBody, warnings, id);
      const content = bodyResult.output;

      // No body at all is unusual but happens for Klaviyo AI-content templates
      // where the body is generated at send time. The merchant has to rebuild
      // those manually — fall back to a WAIT stub with a clear message so the
      // chain stays connected.
      if (!content.trim()) {
        warnings.push({
          kind: "skipped-step",
          actionId: id,
          message: `send-sms has no body content (likely a Klaviyo AI-content template). Emitted WAIT stub; merchant must rebuild the SMS manually.`,
        });
        return skipStub(
          id,
          `SKIPPED SMS: empty body (Klaviyo AI content?)`,
          next,
          state,
        );
      }

      const sentinelId = new ObjectId().toString();
      const previewName = msg.name && String(msg.name).trim()
        ? String(msg.name).trim()
        : `SMS — ${rawBody.slice(0, 40).replace(/\s+/g, " ")}${rawBody.length > 40 ? "…" : ""}`;

      const templateWarnings: string[] = [];
      if (bodyResult.unmappedTokens.length > 0) {
        templateWarnings.push(
          `Liquid tokens we couldn't map: ${bodyResult.unmappedTokens.join(", ")} — verify in Redo SMS editor.`,
        );
      }
      if (msg.image_id) {
        templateWarnings.push(
          `Klaviyo image_id=${msg.image_id} (MMS attachment) dropped — Redo SMS attachments are out of scope for v1.`,
        );
        warnings.push({
          kind: "requires-review",
          actionId: id,
          message: `send-sms had image_id=${msg.image_id} (MMS); attachment dropped, body content kept`,
        });
      }
      if (msg.transactional === true) {
        warnings.push({
          kind: "requires-review",
          actionId: id,
          message: `send-sms marked transactional — Redo coerces SmsTemplate.templateType to "marketing"; verify intended audience`,
        });
      }
      if (msg.smart_sending_enabled === false) {
        warnings.push({
          kind: "requires-review",
          actionId: id,
          message: `send-sms has smart_sending_enabled: false; Redo only supports this flow-wide via trigger.shouldSkipSmartSending — review before enabling`,
        });
      }

      placeholderSmsTemplates.push({
        sentinelId,
        klaviyoActionId: id,
        name: previewName,
        content,
        schemaType: flowSchemaType,
        category: flowCategory,
        // Mirror Klaviyo's setting explicitly; Redo's mongoose default is
        // true, so we have to send `false` on the wire to land off.
        autoShortenLinks: msg.shorten_links === true,
        ...(msg.image_id ? { smsImageId: String(msg.image_id) } : {}),
        templateWarnings,
      });

      const step: SendSmsStep = {
        type: StepType.SEND_SMS,
        id,
        templateId: sentinelId,
        phoneNumberFieldName: "customerPhone",
        recipientNameFieldName: "customerFirstName",
        nextId: terminate(next, state),
      };
      return step;
    }

    case "send-webhook": {
      const msg = action.data?.message ?? {};
      const rawUrl: string = msg.url ?? "";
      const rawBody: string = msg.body ?? "";

      // Rewrite Klaviyo Liquid to Redo Liquid in both URL (destinationUrl
      // supports templating) and body. Rewriter returns the unmapped token
      // list; we use that to decide whether the webhook is an "enrichment"
      // payload that can't be salvaged vs. a simple integration webhook.
      const urlResult = rewriteKlaviyoLiquid(rawUrl, warnings, id);
      const bodyResult = rewriteKlaviyoLiquid(rawBody, warnings, id);
      const totalUnmapped =
        urlResult.unmappedTokens.length + bodyResult.unmappedTokens.length;

      // Enrichment-webhook heuristic: >5 unmapped tokens after rewrite means
      // the endpoint depends on Klaviyo-specific data Redo can't provide
      // (IP metadata, UTM enrichment, order history, cart-item loops, etc.).
      // Skip with a DO_NOTHING stub so the merchant sees the breadcrumb.
      if (totalUnmapped > 5) {
        warnings.push({
          kind: "skipped-step",
          actionId: id,
          message: `send-webhook to ${rawUrl} has ${totalUnmapped} unmapped tokens after rewrite — dropped, chain re-stitched past it. Rebuild manually in Redo if needed.`,
        });
        return dropAction(terminate(next, state));
      }

      const headersObj = msg.headers ?? {};
      const headers = Object.entries(headersObj).map(([key, value]) => {
        // Headers are also Liquid-templated in Redo. Rewrite them, but do
        // NOT add to the unmapped count (already counted url + body).
        const hResult = rewriteKlaviyoLiquid(String(value), warnings, id);
        return { key, value: hResult.output };
      });
      const step: SendWebhookStep = {
        type: StepType.SEND_WEBHOOK,
        id,
        destinationUrl: urlResult.output,
        headers,
        payload: bodyResult.output,
        nextId: terminate(next, state),
        disabled: false,
        authType: null,
      };
      return step;
    }

    case "conditional-split": {
      // Both branch pointers are mongoose-required; route "end path"
      // branches to the shared flow_end terminal.
      const nextTrueId = terminate(action.links?.next_if_true, state);
      const nextFalseId = terminate(action.links?.next_if_false, state);

      // Klaviyo represents random/weighted splits as a conditional-split
      // whose only condition is `profile-sample` with a `percentage`. That's
      // the same primitive Redo calls AB_TEST (UI: "Weighted branch"). Map
      // directly so the merchant gets a usable random split instead of a
      // TODO condition.
      const sample = findProfileSample(action);
      if (sample) {
        const truePct = Math.max(0, Math.min(100, Math.round(sample.percentage ?? 50)));
        const falsePct = 100 - truePct;
        const step: AbTestStep = {
          type: StepType.AB_TEST,
          id,
          variants: [
            { id: `${id}-v1`, name: `Variant A (${truePct}%)`, weight: truePct, nextId: nextTrueId },
            { id: `${id}-v2`, name: `Variant B (${falsePct}%)`, weight: falsePct, nextId: nextFalseId },
          ],
        };
        return step;
      }

      // Otherwise emit a real CONDITION step. Translate profile-metric
      // conditions into Redo's InlineSegment format (customer_activity with
      // count + timeframe). Unmapped condition types stay as warnings and
      // omit from the expression.
      const expression = translateConditionalSplitExpression(action, metrics, warnings);
      const conditionCount =
        (expression as any)?.inlineSegment?.conditions?.length ?? 0;
      const customTitle =
        conditionCount > 0
          ? undefined
          : `TODO: configure condition (was Klaviyo conditional-split)`;
      const step: ConditionStep = {
        type: StepType.CONDITION,
        id,
        ...(customTitle ? { customTitle } : {}),
        expression,
        nextTrueId,
        nextFalseId,
      };
      return step;
    }

    case "trigger-split": {
      // Trigger-splits evaluate event properties (product name, cart value).
      // Translate to Redo's TriggerData schemaBooleanExpression when possible;
      // fall back to an empty inline-segment CONDITION with a warning if the
      // Klaviyo field doesn't have a Redo equivalent in this trigger's schema.
      const nextTrueId = terminate(action.links?.next_if_true, state);
      const nextFalseId = terminate(action.links?.next_if_false, state);
      const tsExpr = translateTriggerSplitExpression(action, flowSchemaType, warnings);
      const expression = tsExpr ?? {
        dataSource: "inline-segment",
        inlineSegment: { mode: "AND", conditions: [] },
      };
      const step: ConditionStep = {
        type: StepType.CONDITION,
        id,
        ...(tsExpr
          ? {}
          : { customTitle: `TODO: configure condition (was Klaviyo trigger-split)` }),
        expression,
        nextTrueId,
        nextFalseId,
      };
      return step;
    }

    case "ab-test": {
      // Klaviyo ab-test wraps a real send-email inside `data.main_action` —
      // that's the "winning" / default email the test serves. Per merchant
      // feedback (2026-05-05), we drop the split entirely and emit just
      // that email as a normal SendEmail step. Variant data isn't a separate
      // top-level action (it's embedded in the ab-test), so dropping the
      // wrapper preserves the email content with no orphans.
      const mainAction = action.data?.main_action;
      if (mainAction?.type === "send-email") {
        // Re-dispatch as a synthetic send-email action sharing the ab-test's
        // id and merge-point next pointer. The embedded action's own next is
        // null (it's a leaf inside the test); we route to ab-test.links.next.
        const synthetic: KlaviyoAction = {
          id,
          type: "send-email",
          data: mainAction.data,
          links: { next },
        };
        return convertAction(
          synthetic,
          metrics,
          flowSchemaType,
          flowCategory,
          templateResolver,
          account,
          warnings,
          placeholderTemplates,
          placeholderSmsTemplates,
          state,
        );
      }
      // Unexpected ab-test shape — fall through to drop policy below.
      warnings.push({
        kind: "unsupported-action",
        actionId: id,
        message: `ab-test action ${id} has no embedded send-email main_action — dropped`,
      });
      return dropAction(terminate(next, state));
    }

    // Drop policy: actions with no Redo equivalent that would otherwise leave
    // a "TODO" WAIT stub for the merchant to clean up. Re-stitch chain past
    // them using the drop sentinel.
    case "update-profile":
    case "list-update":
    case "target-date":
    default: {
      warnings.push({
        kind: "unsupported-action",
        actionId: id,
        message: `action type "${action.type}" has no Redo equivalent — dropped, chain re-stitched past it`,
      });
      return dropAction(
        terminate(next ?? action.links?.next_if_false ?? action.links?.next_if_true, state),
      );
    }
  }
}

export async function parseFlow(
  flow: KlaviyoFlow,
  metrics: MetricLookup,
  opts: {
    teamId: string;
    createdByUserId?: string;
    templateResolver?: TemplateResolver | null;
    /** Klaviyo account for org-variable substitution in subject + preview
     *  text on flow-attached templates. Same role as the account in
     *  exportTemplateFromHtml; passed through here because flow's
     *  subject_line override happens after the resolver returns. */
    account?: KlaviyoAccount | null;
    /** When provided, bypass auto-resolution and use this trigger. Caller
     *  uses this to recover from an "unresolvable trigger" skip by asking
     *  the user to pick a Redo trigger and re-running parseFlow. */
    forcedTrigger?: TriggerResolution;
  },
): Promise<ParseResult> {
  const warnings: ParseWarning[] = [];
  const placeholderTemplates: PlaceholderTemplate[] = [];
  const placeholderSmsTemplates: PlaceholderSmsTemplate[] = [];

  const resolution = opts.forcedTrigger ?? resolveTrigger(flow, metrics, warnings);
  if (!resolution) {
    const klaviyoTrigger = flow.data.attributes.definition?.triggers?.[0];
    return {
      automation: null,
      warnings,
      placeholderTemplates: [],
      placeholderSmsTemplates: [],
      // recoverable: caller can prompt the user, then re-call parseFlow with
      // opts.forcedTrigger to produce a usable AdvancedFlow.
      skipped: {
        reason: "unresolvable trigger",
        recoverable: true,
        klaviyoTrigger,
      },
    };
  }

  const defn = flow.data.attributes.definition;
  const firstActionId = defn?.actions?.[0]?.id;

  const state: ParseState = { needsTerminal: false };

  // Build the skip condition list. Both Klaviyo "Viewed Product" and "Active
  // on Site" map to MARKETING_BROWSE_ABANDONMENT, so we layer a mutually-
  // exclusive viewed-product activity skip on top of the abandonment skip
  // to keep the two flows from double-firing on the same customer.
  const skipConditions: unknown[] = [];
  if (resolution.autoSkipAbandonmentField) {
    skipConditions.push({
      dataSource: "trigger-data",
      schemaBooleanExpression: {
        type: "boolean_evaluation",
        field: resolution.autoSkipAbandonmentField,
        value: false,
      },
    });
  }
  // Flow-level profile_filter: Klaviyo says "only run for profiles
  // matching these conditions". Redo expresses it as a skipCondition on
  // the trigger step (semantically inverted: "skip if the profile does
  // NOT match"). See translateFlowProfileFilter for the De Morgan logic.
  // Push BEFORE the abandonment + activity skips so the filter applies
  // alongside them under OR conjunction at the trigger level.
  const profileFilterSkip = translateFlowProfileFilter(
    defn?.profile_filter,
    metrics,
    warnings,
  );
  if (profileFilterSkip) {
    skipConditions.push(profileFilterSkip);
  }

  // Flow-level `definition.reentry_criteria`: Klaviyo's "wait N days
  // before letting the same profile re-enter THIS flow". Redo has no
  // native flow-level re-entry interval field; the closest available
  // shape is a skip condition on the trigger that excludes profiles
  // who have RECEIVED ANY EMAIL within the window. Imperfect — Redo's
  // skip checks all emails, not just this flow's — but better than
  // dropping the field entirely. The warning makes the approximation
  // explicit so the merchant can refine in the Redo flow builder.
  //
  // Per memory `feedback_flow_status_mapping`, imported flows land
  // inactive — so this approximation gets human review before going
  // live regardless of how broad it is in the wrong direction.
  const reentry = (defn as any)?.reentry_criteria as
    | { duration?: number; unit?: string }
    | undefined;
  if (reentry && Number.isFinite(reentry.duration) && (reentry.duration ?? 0) > 0) {
    const rawUnit = String(reentry.unit ?? "day").toLowerCase();
    const units: "minute" | "hour" | "day" =
      rawUnit === "minute" || rawUnit === "minutes" ? "minute" :
      rawUnit === "hour" || rawUnit === "hours" ? "hour" :
      "day";
    skipConditions.push({
      dataSource: "inline-segment",
      inlineSegment: {
        mode: "AND",
        conditions: [
          {
            type: "customer_activity",
            activityType: "received-email",
            count: { type: "at_least_once" },
            timeframe: {
              type: "before-now-relative",
              value: reentry.duration,
              units,
            },
            whereConditions: [],
          },
        ],
      },
    });
    const unitLabel = reentry.duration === 1 ? units : `${units}s`;
    warnings.push({
      kind: "requires-review",
      message: `Klaviyo flow has reentry_criteria duration=${reentry.duration} ${unitLabel}; Redo has no native flow-level re-entry interval, so this PR approximates it as "skip if customer received any email in the last ${reentry.duration} ${unitLabel}". The Redo skip is broader than Klaviyo's "only this flow" scope — refine in the flow builder if needed.`,
    });
  }

  // Klaviyo's per-trigger `trigger_filter` (a product/event filter that
  // gates which trigger events fire the flow). When present, surface it
  // for manual review; mime doesn't yet translate it to a trigger-data
  // schemaBooleanExpression at the flow level. Charlie 1 Horse's flows
  // have trigger_filter: null, so this branch never fires for them.
  const triggers = defn?.triggers ?? [];
  for (const t of triggers) {
    if (t.trigger_filter) {
      warnings.push({
        kind: "requires-review",
        message: `Klaviyo trigger ${t.id ?? "?"} has a trigger_filter (product/event filter) that mime doesn't yet translate at the flow level — configure manually in the Redo flow builder`,
      });
    }
  }

  if (resolution.klaviyoSource) {
    let window = extractFirstTimeDelayWindow(flow);
    if (!window) {
      warnings.push({
        kind: "requires-review",
        message: `${resolution.klaviyoSource === "viewed-product" ? "Viewed Product" : "Active on Site"} flow has no time-delay action — defaulting viewed-product skip window to 24 hours`,
      });
      window = { value: 24, units: "hour" };
    }
    // Viewed Product flow → skip if customer did NOT view a product in window.
    // Active on Site flow → skip if customer DID view a product in window.
    const count =
      resolution.klaviyoSource === "viewed-product"
        ? { type: "zero_times" }
        : { type: "at_least_once" };
    skipConditions.push({
      dataSource: "inline-segment",
      inlineSegment: {
        mode: "AND",
        conditions: [
          {
            type: "customer_activity",
            activityType: "viewed-product",
            count,
            timeframe: {
              type: "before-now-relative",
              value: window.value,
              units: window.units,
            },
            whereConditions: [],
          },
        ],
      },
    });
  }

  const triggerStep: TriggerStep = {
    type: StepType.TRIGGER,
    id: TRIGGER_STEP_ID,
    schemaType: resolution.schemaType,
    category: resolution.category,
    key: resolution.key,
    nextId: terminate(firstActionId, state),
    ...(skipConditions.length > 0
      ? { skipConditions: { conjunctionMode: "OR", conditions: skipConditions } }
      : {}),
  };

  const steps: Step[] = [triggerStep];
  // {droppedActionId → its replacement target} so we can re-stitch chain
  // pointers in a post-pass. Resolved transitively: if A drops to B and B
  // drops to C, references to A become C.
  const dropRedirects = new Map<string, string>();
  for (const action of defn?.actions ?? []) {
    const result = await convertAction(
      action,
      metrics,
      resolution.schemaType,
      resolution.category,
      opts.templateResolver ?? null,
      opts.account ?? null,
      warnings,
      placeholderTemplates,
      placeholderSmsTemplates,
      state,
    );
    if (!result) continue;
    if (isDropResult(result)) {
      dropRedirects.set(action.id, result.redirectTo);
      continue;
    }
    steps.push(result);
  }

  // Resolve transitive drops so a single hop replacement always lands on a
  // surviving step id. Bounded loop in case of pathological data.
  const resolveRedirect = (id: string): string => {
    let cur = id;
    for (let i = 0; i < 32 && dropRedirects.has(cur); i++) {
      cur = dropRedirects.get(cur)!;
    }
    return cur;
  };

  // Re-stitch every pointer field on every surviving step. Without this the
  // chain would still reference the dropped ids, leaving disconnected steps
  // in Redo's flow editor.
  for (const step of steps) {
    const s = step as any;
    if (typeof s.nextId === "string" && dropRedirects.has(s.nextId)) {
      s.nextId = resolveRedirect(s.nextId);
    }
    if (typeof s.nextTrueId === "string" && dropRedirects.has(s.nextTrueId)) {
      s.nextTrueId = resolveRedirect(s.nextTrueId);
    }
    if (typeof s.nextFalseId === "string" && dropRedirects.has(s.nextFalseId)) {
      s.nextFalseId = resolveRedirect(s.nextFalseId);
    }
    if (Array.isArray(s.variants)) {
      for (const v of s.variants) {
        if (typeof v.nextId === "string" && dropRedirects.has(v.nextId)) {
          v.nextId = resolveRedirect(v.nextId);
        }
      }
    }
  }
  // Trigger step's nextId also needs re-stitching (it points at firstActionId).
  if (typeof triggerStep.nextId === "string" && dropRedirects.has(triggerStep.nextId)) {
    triggerStep.nextId = resolveRedirect(triggerStep.nextId);
  }

  // Append the shared terminal step if any branch/pointer pointed at it.
  // DO_NOTHING has no required fields beyond type+id, so this is safe to
  // leave dangling (no nextId needed).
  if (state.needsTerminal) {
    const terminal: DoNothingStep = {
      type: StepType.DO_NOTHING,
      id: FLOW_END_ID,
      customTitle: "End of flow",
    };
    steps.push(terminal);
  }

  // Klaviyo allows branch re-merging; Redo's advanced flows are trees. Clone
  // any step reachable from >1 parent so each incoming branch has its own
  // copy of the downstream subtree. flow_end stays shared.
  const treeifiedSteps = treeifyFlow(steps, warnings);

  // Always import as inactive so the merchant can review the flow in Redo
  // before it starts firing — even if the Klaviyo source was live. Original
  // Klaviyo status is captured in the description for reference.
  const status = flow.data.attributes.status;
  const enabled = false;

  const automation: AdvancedFlow = {
    team: opts.teamId,
    name: flow.data.attributes.name,
    description: `Imported from Klaviyo flow ${flow.data.id} (Klaviyo status: ${status})`,
    enabled,
    steps: treeifiedSteps,
    schemaType: resolution.schemaType,
    category: resolution.category,
    ...(opts.createdByUserId ? { createdByUserId: opts.createdByUserId } : {}),
    versionGroupId: new ObjectId().toString(),
  };

  return { automation, warnings, placeholderTemplates, placeholderSmsTemplates };
}

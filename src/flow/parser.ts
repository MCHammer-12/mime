import { ObjectId } from "bson";
import type { MetricLookup } from "../extract-metrics.js";
import {
  translateConditionalSplitExpression,
  translateTriggerSplitExpression,
} from "./condition-mapping.js";
import type { TemplateResolver } from "./template-resolver.js";
import { treeifyFlow } from "./treeify.js";
import { resolveTrigger } from "./trigger-mapping.js";
import { rewriteKlaviyoLiquid } from "./variable-mapping.js";
import {
  SchemaType,
  StepType,
  WaitTimeUnit,
  type AdvancedFlow,
  type ConditionStep,
  type DoNothingStep,
  type KlaviyoAction,
  type KlaviyoFlow,
  type ParseResult,
  type ParseWarning,
  type PlaceholderTemplate,
  type SendEmailStep,
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

// Per-action dispatcher. Emits exactly one Redo Step (or skips with a warning).
// Async because the send-email handler may need to resolve + parse the
// referenced Klaviyo template (HTML → full Redo EmailTemplate JSON).
async function convertAction(
  action: KlaviyoAction,
  metrics: MetricLookup,
  flowSchemaType: SchemaType,
  templateResolver: TemplateResolver | null,
  warnings: ParseWarning[],
  placeholderTemplates: PlaceholderTemplate[],
  state: ParseState,
): Promise<Step | null> {
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
        if (resolved) {
          fullTemplate = resolved.template;
          templateWarnings.push(...resolved.warnings);
          // Carry through per-step metadata onto the template so the
          // importer uses Klaviyo's subject/from/preview instead of the
          // HTML parser's defaults.
          if (msg.subject_line) fullTemplate.subject = msg.subject_line;
          if (msg.preview_text) fullTemplate.emailPreview = msg.preview_text;
        } else {
          warnings.push({
            kind: "requires-review",
            actionId: id,
            message: `send-email references Klaviyo template ${msg.template_id} but it wasn't found in the merchant's templates-manifest.json — emitted as blank placeholder. Run extract-templates.ts for this merchant.`,
          });
        }
      }
      placeholderTemplates.push({
        sentinelId,
        klaviyoTemplateId: msg.template_id ?? null,
        subject: msg.subject_line ?? "",
        fromEmail: msg.from_email ?? null,
        fromLabel: msg.from_label ?? null,
        previewText: msg.preview_text ?? null,
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
      // Redo's SendSmsStep requires a real SMS templateId (ObjectId string);
      // we'd need a createSmsTemplate RPC + SMS template construction to
      // emit a valid SendSmsStep. Until that's built, emit a DO_NOTHING stub
      // with the body preserved in customTitle so the merchant can rebuild
      // the SMS manually in Redo.
      const msg = action.data?.message ?? {};
      const body = String(msg.body ?? "");
      const preview = body.slice(0, 60).replace(/\s+/g, " ");
      warnings.push({
        kind: "skipped-step",
        actionId: id,
        message: `send-sms step skipped: Redo SMS requires a pre-built template (not yet supported by migration). Body: "${body.slice(0, 200)}"`,
      });
      if (msg.image_id) {
        warnings.push({
          kind: "requires-review",
          actionId: id,
          message: `send-sms had image_id=${msg.image_id} (MMS); rebuild manually in Redo`,
        });
      }
      const stub: DoNothingStep = {
        type: StepType.DO_NOTHING,
        id,
        customTitle: `SKIPPED SMS: ${preview}${body.length > 60 ? "…" : ""}`,
        nextId: terminate(next, state),
      };
      return stub;
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
          message: `send-webhook to ${rawUrl} has ${totalUnmapped} unmapped tokens after rewrite — replaced with DO_NOTHING. Rebuild manually in Redo.`,
        });
        const stub: DoNothingStep = {
          type: StepType.DO_NOTHING,
          id,
          customTitle: `SKIPPED: webhook to ${rawUrl.slice(0, 60)}`,
          nextId: terminate(next, state),
        };
        return stub;
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
      // Emit a real CONDITION step. Translate profile-metric conditions into
      // Redo's InlineSegment format (customer_activity with count + timeframe).
      // Unmapped condition types stay as warnings and omit from the expression.
      // Both nextTrueId and nextFalseId are mongoose-required; route "end path"
      // branches to the shared flow_end terminal.
      const nextTrueId = terminate(action.links?.next_if_true, state);
      const nextFalseId = terminate(action.links?.next_if_false, state);
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

    // Remaining unsupported actions — emit DO_NOTHING. These don't have
    // branch links, so a single nextId preserves the main path.
    case "ab-test":
    case "update-profile":
    case "list-update":
    case "target-date":
    default: {
      warnings.push({
        kind: "unsupported-action",
        actionId: id,
        message: `action type "${action.type}" is not yet implemented — emitted DO_NOTHING stub`,
      });
      const stub: DoNothingStep = {
        type: StepType.DO_NOTHING,
        id,
        customTitle: `TODO: ${action.type} (rebuild manually)`,
        // ab-test links through main_action.next; update-profile / list-update
        // always use plain next. Fall back to either branch pointer if we
        // encounter an unexpected shape; terminate if all are absent.
        nextId: terminate(
          next ?? action.links?.next_if_false ?? action.links?.next_if_true,
          state,
        ),
      };
      return stub;
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
  },
): Promise<ParseResult> {
  const warnings: ParseWarning[] = [];
  const placeholderTemplates: PlaceholderTemplate[] = [];

  const resolution = resolveTrigger(flow, metrics, warnings);
  if (!resolution) {
    return {
      automation: null,
      warnings,
      placeholderTemplates: [],
      skipped: { reason: "unresolvable trigger" },
    };
  }

  const defn = flow.data.attributes.definition;
  const firstActionId = defn?.actions?.[0]?.id;

  const state: ParseState = { needsTerminal: false };

  const triggerStep: TriggerStep = {
    type: StepType.TRIGGER,
    id: TRIGGER_STEP_ID,
    schemaType: resolution.schemaType,
    category: "Marketing",
    key: resolution.key,
    nextId: terminate(firstActionId, state),
    ...(resolution.autoSkipAbandonmentField
      ? {
          skipConditions: {
            conjunctionMode: "OR",
            conditions: [
              {
                dataSource: "trigger-data",
                schemaBooleanExpression: {
                  type: "boolean_evaluation",
                  field: resolution.autoSkipAbandonmentField,
                  value: false,
                },
              },
            ],
          },
        }
      : {}),
  };

  const steps: Step[] = [triggerStep];
  for (const action of defn?.actions ?? []) {
    const step = await convertAction(
      action,
      metrics,
      resolution.schemaType,
      opts.templateResolver ?? null,
      warnings,
      placeholderTemplates,
      state,
    );
    if (step) steps.push(step);
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

  const status = flow.data.attributes.status;
  const enabled = status === "live";

  const automation: AdvancedFlow = {
    team: opts.teamId,
    name: flow.data.attributes.name,
    description: `Imported from Klaviyo flow ${flow.data.id}`,
    enabled,
    steps: treeifiedSteps,
    schemaType: resolution.schemaType,
    category: "Marketing",
    ...(opts.createdByUserId ? { createdByUserId: opts.createdByUserId } : {}),
    versionGroupId: new ObjectId().toString(),
  };

  return { automation, warnings, placeholderTemplates };
}

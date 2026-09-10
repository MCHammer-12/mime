// Fidelity and logic QA — the checks that read the *store*, not the parse.
//
// verify-import.ts diffs Redo against mime's own parse. That catches an import
// that didn't land, but it can't catch an import that landed exactly as mime
// intended and is still wrong: if the parser is wrong, the verifier agrees with
// it and reports clean. Everything here checks an absolute invariant instead —
// something that is broken no matter what the parser thought.
//
// Sources for the invariants:
//   - empty inline segment matches NOBODY, not everyone
//     (redoapp redo/marketing/db/util/src/segments/evaluate-segment-membership.ts:184)
//   - previewEmailTemplate returns the rendered HTML a recipient would get
//     (redoapp redo/merchant/marketing/app/src/campaigns/email-preview-query.spec.ts:12)

import type { Check } from "./verify-import.js";

const OBJECT_ID = /^[0-9a-f]{24}$/;

function label(flow: Record<string, any>): string {
  return String(flow.name ?? flow._id);
}

/**
 * A condition step whose inline segment carries no conditions. Redo evaluates it
 * to false for every customer, so the true branch is dead code and every profile
 * takes the false path. Silent: the flow looks imported and behaves differently.
 */
export function deadBranchChecks(flow: Record<string, any>): Check[] {
  const steps: Array<Record<string, any>> = flow.steps ?? [];
  const byId = new Map(steps.map((s) => [String(s.id), s]));
  const checks: Check[] = [];

  for (const step of steps) {
    if (String(step.type) !== "condition") continue;
    const expr = step.expression as Record<string, any> | undefined;
    if (!expr || expr.dataSource !== "inline-segment") continue;
    const conditions = expr.inlineSegment?.conditions;
    if (Array.isArray(conditions) && conditions.length > 0) continue;

    const deadType = byId.get(String(step.nextTrueId))?.type ?? "missing";
    checks.push({
      item: `condition ${step.id} in "${label(flow)}"`,
      dimension: "logic",
      verdict: "broken",
      detail:
        `inline segment has no conditions — matches nobody, so every profile takes ` +
        `the false path (${step.nextFalseId}) and the true branch (${deadType} ` +
        `${step.nextTrueId}) never runs`,
    });
  }
  return checks;
}

const EDGE_KEYS = new Set(["nextId", "nextTrueId", "nextFalseId"]);

/**
 * Every id this step hands control to. Edges are not always top-level: an
 * ab_test carries one per entry in `variants[]`, so a flat read of
 * nextId/nextTrueId/nextFalseId declares the whole downstream chain dead.
 * Walk the step object instead and take every *Id key that names a successor.
 */
function outgoingEdges(step: Record<string, any>): Array<{ key: string; value: string }> {
  const found: Array<{ key: string; value: string }> = [];
  const visit = (node: unknown, path: string) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => visit(v, `${path}[${i}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (EDGE_KEYS.has(k)) {
        if (v !== undefined && v !== null) found.push({ key: path ? `${path}.${k}` : k, value: String(v) });
        continue;
      }
      visit(v, path ? `${path}.${k}` : k);
    }
  };
  visit(step, "");
  return found;
}

/**
 * Walk the graph from the trigger. Anything not reached is dead — usually a
 * branch left dangling when a step was dropped and the chain re-stitched around
 * it. A send step stranded this way is an email the merchant thinks they migrated.
 */
export function reachabilityChecks(flow: Record<string, any>): Check[] {
  const steps: Array<Record<string, any>> = flow.steps ?? [];
  if (steps.length === 0) return [];
  const byId = new Map(steps.map((s) => [String(s.id), s]));

  const start = steps.find((s) => String(s.type) === "trigger") ?? steps[0];
  const seen = new Set<string>();
  const queue = [String(start.id)];
  const checks: Check[] = [];

  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const step = byId.get(id);
    if (!step) continue;
    for (const { key, value } of outgoingEdges(step)) {
      const nextId = String(value);
      if (!byId.has(nextId)) {
        checks.push({
          item: `step ${id}.${key} in "${label(flow)}"`,
          dimension: "structure",
          verdict: "broken",
          detail: `points at "${nextId}", which is not a step in this flow`,
        });
        continue;
      }
      queue.push(nextId);
    }
  }

  for (const step of steps) {
    const id = String(step.id);
    if (seen.has(id)) continue;
    const type = String(step.type);
    // An unreachable do_nothing is a tidy-up artifact, not a lost message.
    const verdict = type === "do_nothing" ? "degraded" : "broken";
    checks.push({
      item: `step ${id} (${type}) in "${label(flow)}"`,
      dimension: "structure",
      verdict,
      detail: "unreachable — nothing in the flow points at it",
    });
  }
  return checks;
}

/** Every imported flow lands inactive. A live one is a flow that can send today. */
export function activationChecks(flow: Record<string, any>): Check[] {
  if (flow.enabled !== true) return [];
  return [
    {
      item: `flow "${label(flow)}" enabled`,
      dimension: "logic",
      verdict: "broken",
      detail: "flow is ACTIVE — imports must land inactive until a human turns them on",
    },
  ];
}

/**
 * Two flows on the same trigger key both fire for the same event. Activating a
 * migrated flow next to a pre-existing one on that key double-sends.
 *
 * Segment-membership triggers are the exception: a flow gated on one segment
 * right after the trigger (mime's SEGMENT_ID gate, or a hand-built one) only
 * fires for that segment, so two gated flows on different segments don't
 * collide. An ungated flow on the key still collides with every other.
 */
export function triggerCollisionChecks(
  flows: Array<Record<string, any>>,
  scopeIds?: Set<string>,
): Check[] {
  const byKey = new Map<string, Array<{ name: string; inScope: boolean; segment: string | null }>>();
  for (const flow of flows) {
    const steps: any[] = flow.steps ?? [];
    const trigger = steps.find((s: any) => String(s.type) === "trigger");
    const key = trigger?.key ?? trigger?.schemaType;
    if (!key) continue;
    const list = byKey.get(String(key)) ?? [];
    list.push({
      name: label(flow),
      inScope: !scopeIds || scopeIds.has(String(flow._id)),
      segment: gatedSegment(steps, trigger),
    });
    byKey.set(String(key), list);
  }

  const checks: Check[] = [];
  for (const [key, all] of byKey) {
    // Gated flows on distinct segments never see the same event, so they only
    // collide with each other per segment — unless an ungated flow is on the
    // key, which fires for every segment and collides with all of them.
    const ungated = all.filter((e) => e.segment === null);
    const groups = new Map<string, typeof all>();
    if (ungated.length) groups.set("", all);
    else for (const e of all) groups.set(e.segment!, [...(groups.get(e.segment!) ?? []), e]);
    for (const [segment, entries] of groups) {
      if (entries.length < 2) continue;
      // Two of the merchant's own flows sharing a key predates this run — only
      // report a collision this migration is a party to.
      if (!entries.some((e) => e.inScope)) continue;
      const names = entries.map((e) => e.name);
      const ungatedNote =
        ungated.length && ungated.length < all.length
          ? `; ungated: ${ungated.map((e) => e.name).join(", ")} — gate it on a segment to separate them`
          : "";
      checks.push({
        item: segment ? `trigger "${key}" on segment ${segment}` : `trigger "${key}"`,
        dimension: "logic",
        verdict: "degraded",
        detail: `${names.length} flows share it — activating more than one double-sends: ${names.join(", ")}${ungatedNote}`,
      });
    }
  }
  return checks;
}

/** The segment id a flow is pinned to by a condition directly after its trigger, else null. */
function gatedSegment(steps: any[], trigger: any): string | null {
  const first = steps.find((s: any) => String(s.id) === String(trigger?.nextId));
  const expr = first?.type === "condition" ? first.expression?.schemaBooleanExpression : undefined;
  if (first?.expression?.dataSource !== "trigger-data" || expr?.field !== "segment") return null;
  const values: unknown[] = Array.isArray(expr.matchValues) ? expr.matchValues : [];
  return expr.operator === "equals" && values.length === 1 ? String(values[0]) : null;
}

// ─── rendered-email fidelity ───────────────────────────────────────────────

// Klaviyo's asset CDN. An image still served from it renders today and 404s
// whenever the merchant's Klaviyo account lapses.
const KLAVIYO_ASSET_HOST = "d3k81ch9hvuctc.cloudfront.net";
const KLAVIYO_LINK_HOSTS = ["trk.klaviyomail.com", "klclick.com", "klclick1.com", "a.klaviyo.com"];
// previewEmailTemplate substitutes a stand-in for the real per-recipient
// unsubscribe URL; any marker proves the link is wired. Some schemas resolve
// {{ unsubscribe_link }} to a real tokenised URL in preview
// (returns.getredo.com/.../marketing/unsubscribe?...) rather than a stand-in —
// without that marker 7 wired links scored broken (Bronco Western 2026-09-02).
const UNSUBSCRIBE_MARKERS = [
  "example.com/unsubscribe",
  "named_unsubscribe-link",
  "/marketing/unsubscribe",
];
const STUB_SUBJECT = /^(email #\d+ subject|subject line \d+|untitled|test)$/i;

// Redo runtime variables that createEmailTemplate accepts but preview leaves
// unresolved (no trigger product exists in preview context). A rendered token
// that reads ONLY from these roots resolves at send time and isn't a leak —
// unless its filter chain drags in Klaviyo data, which never resolves.
const REDO_RUNTIME_TOKEN_ROOTS = ["restocked_product", "discounted_product"];
const KLAVIYO_LEAK_RE = /\b(person|event|organization|catalog_item)\b/;
function isRedoRuntimeToken(token: string): boolean {
  if (KLAVIYO_LEAK_RE.test(token)) return false;
  const m = /^\{\{\s*([a-z_]+)\./.exec(token);
  return m !== null && REDO_RUNTIME_TOKEN_ROOTS.includes(m[1]!);
}

export interface RenderedTemplate {
  id: string;
  name?: string;
  subject?: string;
  html: string;
}

/**
 * Check one rendered email against what a recipient would actually see.
 * `requireUnsubscribe` is off for transactional-style sends that legitimately
 * carry no unsubscribe link.
 */
export function renderChecks(
  tpl: RenderedTemplate,
  { requireUnsubscribe = true }: { requireUnsubscribe?: boolean } = {},
): Check[] {
  const checks: Check[] = [];
  const name = tpl.name ?? tpl.id;
  const item = (suffix: string) => `"${name}" ${suffix}`;
  const html = tpl.html ?? "";

  const liquid = [
    ...(html.match(/\{\{[^}]{0,80}\}\}/g) ?? []),
    ...(html.match(/\{%[^%]{0,80}%\}/g) ?? []),
  ].filter((t) => !isRedoRuntimeToken(t));
  if (liquid.length) {
    checks.push({
      item: item("liquid"),
      dimension: "fidelity",
      verdict: "broken",
      detail: `${liquid.length} unresolved token(s) render as literal text: ${[...new Set(liquid)].slice(0, 3).join(" ")}`,
    });
  }

  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 40) {
    checks.push({
      item: item("body"),
      dimension: "fidelity",
      verdict: "broken",
      detail: `renders ${text.length} characters of visible text — effectively blank`,
    });
  }

  if (requireUnsubscribe && !UNSUBSCRIBE_MARKERS.some((m) => html.includes(m))) {
    checks.push({
      item: item("unsubscribe"),
      dimension: "fidelity",
      verdict: "broken",
      detail: "no unsubscribe link in the rendered output",
    });
  }

  if (html.includes(KLAVIYO_ASSET_HOST)) {
    const n = html.split(KLAVIYO_ASSET_HOST).length - 1;
    checks.push({
      item: item("assets"),
      dimension: "fidelity",
      verdict: "degraded",
      detail: `${n} asset(s) still served from Klaviyo's CDN — they break when the merchant leaves Klaviyo`,
    });
  }

  const leakedLinks = KLAVIYO_LINK_HOSTS.filter((h) => html.includes(h));
  if (leakedLinks.length) {
    checks.push({
      item: item("links"),
      dimension: "fidelity",
      verdict: "broken",
      detail: `link(s) point back at Klaviyo (${leakedLinks.join(", ")}) — clicks leave the merchant's domain`,
    });
  }

  const subject = String(tpl.subject ?? "").trim();
  if (!subject || STUB_SUBJECT.test(subject) || subject.startsWith("[Placeholder]")) {
    checks.push({
      item: item("subject"),
      dimension: "fidelity",
      verdict: "broken",
      detail: subject ? `subject is a stub: "${subject}"` : "no subject line",
    });
  }

  if (checks.length === 0) {
    checks.push({
      item: item("render"),
      dimension: "fidelity",
      verdict: "clean",
      detail:
        `${text.length} chars of text, ` +
        (requireUnsubscribe ? "unsubscribe present, " : "") +
        "no leaked Klaviyo references",
    });
  }
  return checks;
}

/**
 * Every send step in the store, deduplicated by template id — the set worth
 * paying a render call for.
 */
export function sendTemplateIds(flows: Array<Record<string, any>>): Set<string> {
  const ids = new Set<string>();
  for (const flow of flows) {
    for (const step of flow.steps ?? []) {
      if (String(step.type) !== "send_email") continue;
      const id = String(step.templateId ?? "");
      if (OBJECT_ID.test(id)) ids.add(id);
    }
  }
  return ids;
}

// Mock NDJSON stream. Matches real API contract, plus needs_input.

async function* mockRunStream({ templateIds, flowIds, flows, templates, signal, storeName, answerBroker }) {
  const sleep = (ms) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
  });

  const shouldFail = (id) => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffffffff;
    return Math.abs(h) % 100 < 8;
  };
  const h2 = (id) => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 13 + id.charCodeAt(i)) & 0xffffffff;
    return Math.abs(h);
  };

  const failReasons = [
    "Klaviyo API: 429 rate limit exceeded",
    "Template missing required subject line",
    "Redo RPC: unknown section type 'countdown_block_v2'",
    "Timeout waiting for Klaviyo export (30s)",
    "Invalid merge tag {{ person.custom_field }} — field not in Redo schema",
  ];
  const pickReason = (id) => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 17 + id.charCodeAt(i)) & 0xffffffff;
    return failReasons[Math.abs(h) % failReasons.length];
  };

  // Some items trigger needs_input. Deterministic — ~15% of items.
  const needsInputFor = (id, name) => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 53 + id.charCodeAt(i)) & 0xffffffff;
    const r = Math.abs(h) % 100;
    if (r < 8) return {
      qid: "discount_amount",
      question: `Discount amount for coupon 'AbandonedCart20' — Klaviyo stored it ambiguously. Confirm percent or dollar.`,
      itemName: name,
      options: [
        { value: "percent", label: "20% off" },
        { value: "dollar",  label: "$20 off" },
      ],
    };
    if (r < 15) return {
      qid: "unmapped_var",
      question: `Unmapped URL variable {{ event.CustomField }} in this email. How should it be handled?`,
      itemName: name,
      options: [
        { value: "manual",     label: "Manual placeholder (editable in Redo)" },
        { value: "unresolved", label: "Unresolved (error)" },
        { value: "skip",       label: "Skip this button" },
      ],
    };
    if (r < 20) return {
      qid: "default_firstname",
      type: "text",
      question: `No fallback found for {{ person.first_name }}. What should be used when the customer's name isn't known?`,
      context: `This merge tag appears 3 times in the email (greeting + subject line).`,
      itemName: name,
      default: "friend",
      placeholder: "e.g. friend, valued customer",
    };
    if (r < 24) return {
      qid: "enable_ab",
      type: "boolean",
      question: `Klaviyo A/B subject-line variant detected. Import as a separate template for manual testing in Redo?`,
      context: `Variant B: "Last chance — 20% off ends tonight ⏰"`,
      itemName: name,
      trueLabel: "Import variant",
      falseLabel: "Skip variant",
    };
    return null;
  };

  let imported = 0, importFailed = 0, flowsImported = 0, flowsFailed = 0;

  yield { kind: "step", label: "Fetching Klaviyo account…" };
  await sleep(400);
  yield { kind: "info", text: `Account: ${storeName || "store"} · region us-east-1` };

  // ─ Templates ─
  if (templateIds.length > 0) {
    yield { kind: "step", label: `Exporting ${templateIds.length} template${templateIds.length === 1 ? '' : 's'} from Klaviyo` };
    await sleep(300);

    let exportedCount = 0, exportFailed = 0;
    for (const id of templateIds) {
      const tmpl = templates.find(t => t.id === id);
      if (!tmpl) continue;

      yield { kind: "step", label: `Exporting ${tmpl.name}…` };
      await sleep(300 + Math.random() * 500);

      if (shouldFail(id)) {
        yield { kind: "fail", id, name: tmpl.name, error: pickReason(id) };
        importFailed++; exportFailed++;
        continue;
      }

      // Possibly ask for input
      const q = needsInputFor(id, tmpl.name);
      if (q && answerBroker) {
        const cached = answerBroker.get(q.qid);
        if (!cached) {
          yield { kind: "needs_input", id: `ni_${id}`, itemId: id, itemName: tmpl.name, question: q.question, options: q.options, qid: q.qid, type: q.type, default: q.default, placeholder: q.placeholder, context: q.context, trueLabel: q.trueLabel, falseLabel: q.falseLabel };
          const answer = await answerBroker.wait(q.qid);
          if (answer === "__skip__") {
            yield { kind: "fail", id, name: tmpl.name, error: "skipped by user (needs_input)" };
            importFailed++; exportFailed++;
            continue;
          }
          yield { kind: "info", text: `Applied answer for "${q.qid}": ${answer}` };
        } else {
          yield { kind: "info", text: `Reused answer for "${q.qid}": ${cached}` };
        }
      }

      const sectionCount = 3 + Math.floor(Math.random() * 22);
      const warningsN = Math.random() < 0.3 ? Math.floor(1 + Math.random() * 4) : 0;
      const unsupportedN = Math.random() < 0.2 ? Math.floor(1 + Math.random() * 2) : 0;
      const reviewItemsN = Math.random() < 0.4 ? Math.floor(1 + Math.random() * 3) : 0;
      const aiRewritesN = Math.random() < 0.25 ? Math.floor(1 + Math.random() * 2) : 0;
      const fontPlanEntries = Math.random() < 0.5
        ? [
            { family: "Inter", available: true },
            ...(Math.random() < 0.4 ? [{ family: "Avenir Next", available: false }] : []),
          ]
        : [];

      yield {
        kind: "exported",
        id, name: tmpl.name,
        sectionCount, warnings: warningsN, unsupported: unsupportedN,
        reviewItems: reviewItemsN, aiRewrites: aiRewritesN, fontPlanEntries,
      };
      // Per-item warnings (structured text → classifier on the client)
      const warnTexts = [
        `unmapped token {{ person.first_name|default:\"friend\" }} — suggested: {{ customer.firstName ?? "friend" }}`,
        `unmapped token {{ event.OrderValue }} — no Redo equivalent, left as literal`,
        `unmapped URL variable {{ organization.url }} — replaced with store_url`,
        `degraded mapping: countdown_block_v2 → static image fallback`,
        `degraded mapping: gif autoplay → first-frame still (Redo doesn't autoplay)`,
        `fallback for custom font "Avenir Next" → Inter (closest web-safe match)`,
        `skipped: A/B subject-line variant (not yet supported in Redo)`,
        `skipped step: smart-send time window (not yet mapped)`,
        `review in Redo: hero image uses a merge tag — confirm render in preview`,
        `review alt text on 2 images — Klaviyo source had empty alt`,
        `profile-property filter "prefers_email" translated to segment rule (double-check)`,
      ];
      for (let w = 0; w < warningsN; w++) {
        const t = warnTexts[(w + h2(id)) % warnTexts.length];
        yield { kind: "warn", severity: "warn", itemId: id, itemName: tmpl.name, text: t };
      }
      exportedCount++;
    }

    yield { kind: "summary", exported: exportedCount, failed: exportFailed };
    await sleep(200);

    yield { kind: "step", label: "Uploading brand fonts…" };
    await sleep(500);
    yield {
      kind: "fonts_done",
      uploaded: 3 + Math.floor(Math.random() * 4),
      registeredFamilies: 1 + Math.floor(Math.random() * 3),
      skipped: Math.floor(Math.random() * 2),
      unresolved: Math.random() < 0.4
        ? [{ family: "Avenir Next", reason: "not found in brand kit", usedBy: ["Newsletter Q3", "Editorial v2"] }]
        : [],
    };
    await sleep(200);

    yield { kind: "step", label: "Creating templates…" };
    await sleep(300);
    for (const id of templateIds) {
      const tmpl = templates.find(t => t.id === id);
      if (!tmpl) continue;
      if (shouldFail(id)) continue;

      yield { kind: "step", label: `Importing ${tmpl.name}…` };
      await sleep(300 + Math.random() * 400);
      yield { kind: "imported", id, name: tmpl.name, templateId: `redo_${id.slice(-8)}` };
      imported++;
    }
  }

  // ─ Flows ─
  if (flowIds.length > 0) {
    yield { kind: "step", label: "Fetching Klaviyo metrics…" };
    await sleep(400);

    for (const id of flowIds) {
      const flow = flows.find(f => f.flowId === id);
      if (!flow) continue;
      const emailCount = flow.emails.length;

      yield { kind: "step", label: `Parsing ${flow.flowName}…` };
      await sleep(300 + emailCount * 120);
      yield { kind: "step", label: `Importing ${flow.flowName}…` };
      await sleep(300 + emailCount * 180);

      if (shouldFail(id)) {
        yield { kind: "fail", id, name: flow.flowName, error: pickReason(id) };
        flowsFailed++;
        continue;
      }

      const blank = Math.random() < 0.15 ? 1 : 0;
      const warningCount = Math.random() < 0.35 ? Math.floor(1 + Math.random() * 9) : 0;
      yield {
        kind: "flow_imported",
        id, name: flow.flowName,
        flowId: `redo_flow_${id.slice(-8)}`,
        createdTemplateCount: emailCount - blank,
        blankTemplateCount: blank,
        warningCount,
      };
      const flowWarnTexts = [
        `unmapped token {{ person.last_purchase }} in email ${1 + Math.floor(Math.random()*emailCount)} — left as literal`,
        `degraded mapping: conditional split on custom property → static branch`,
        `degraded mapping: wait-until-event trigger → fixed 24h delay`,
        `skipped: subscribe-preferences step (not yet supported)`,
        `skipped step: push notification send (Redo is email-only)`,
        `review in Redo: trigger filter "profile-has-property" translated — verify match count`,
        `review email ${1 + Math.floor(Math.random()*emailCount)} — merge tag may render blank for new subscribers`,
        `profile-segment membership check translated to list-join event`,
      ];
      for (let w = 0; w < warningCount; w++) {
        const t = flowWarnTexts[(w + h2(id)) % flowWarnTexts.length];
        yield { kind: "warn", severity: "warn", itemId: id, itemName: flow.flowName, text: t };
      }
      flowsImported++;
    }
  }

  yield { kind: "done", importMethod: "rpc", imported, importFailed, flowsImported, flowsFailed };
}

async function* mockRetryStream({ id, name, kind, flow, signal }) {
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  await sleep(500 + Math.random() * 800);
  if (kind === "template") {
    yield { kind: "exported", id, name, sectionCount: 5, warnings: 0, unsupported: 0, reviewItems: 0, aiRewrites: 0, fontPlanEntries: [] };
    await sleep(300);
    yield { kind: "imported", id, name, templateId: `redo_${id.slice(-8)}` };
  } else {
    yield { kind: "flow_imported", id, name, flowId: `redo_flow_${id.slice(-8)}`, createdTemplateCount: flow ? flow.emails.length : 1, blankTemplateCount: 0, warningCount: 0 };
  }
  yield { kind: "done", importMethod: "rpc", imported: kind === "template" ? 1 : 0, importFailed: 0, flowsImported: kind === "flow" ? 1 : 0, flowsFailed: 0 };
}

// Simple pub/sub to deliver needs_input answers back into the generator.
function makeAnswerBroker() {
  const cached = new Map();
  const waiters = new Map();
  return {
    get: (qid) => cached.get(qid),
    wait: (qid) => new Promise(resolve => {
      const existing = waiters.get(qid) || [];
      existing.push(resolve);
      waiters.set(qid, existing);
    }),
    submit: (qid, answer, applyAll) => {
      if (applyAll) cached.set(qid, answer);
      const ws = waiters.get(qid) || [];
      ws.forEach(w => w(answer));
      waiters.set(qid, []);
      if (!applyAll) {
        // Only resolve the first waiter (current), rest will keep waiting for next submit
      }
    },
  };
}

window.mockEnv = { hostedDeploy: false, aiAvailable: true };
window.mockRunStream = mockRunStream;
window.mockRetryStream = mockRetryStream;
window.makeAnswerBroker = makeAnswerBroker;

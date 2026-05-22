// Real NDJSON stream against the server's /api/jobs endpoints. Exports
// window.mockRunStream — name preserved so components keep working
// unchanged.
//
// Flow:
//   1. POST /api/jobs with creds + selected ids → { jobId }
//   2. GET  /api/jobs/:id/stream → NDJSON event stream
//   3. Parse each line as a JobEvent; unwrap `payload` → flat event for the UI
//   4. On needs_input, wait on the answerBroker, then POST /api/jobs/:id/inputs

async function postJsonStream(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // swallow
  }
  if (!res.ok) {
    const msg = json?.error ?? text?.slice(0, 200) ?? res.statusText;
    throw new Error(`${path} ${res.status}: ${msg}`);
  }
  return json;
}

// Translate a backend JobEvent envelope into the flat event shape the
// UI components expect. The envelope looks like:
//   { seq, at, kind, severity, payload: { ...kind-specific fields } }
// The UI reads e.g. evt.text, evt.label, evt.id directly.
function unwrapEvent(env) {
  const p = env.payload ?? {};
  const base = { kind: env.kind, severity: env.severity, seq: env.seq, at: env.at };
  if (env.kind === "needs_input") {
    // Backend: payload.input = { id, questionKey, question, context, type, options, default, itemId, itemLabel }
    // UI expects: qid, question, context, type, options, default, itemId, itemName, trueLabel, falseLabel, _backendInputId
    const input = p.input ?? {};
    return {
      ...base,
      qid: input.questionKey,
      _backendInputId: input.id,
      question: input.question,
      context: input.context,
      type: input.type,
      options: input.options,
      default: input.default,
      itemId: input.itemId,
      itemName: input.itemLabel,
      hideApplyAll: input.hideApplyAll,
      // Optional per-prompt overrides for the boolean modal's Yes/No labels.
      // Backend surfaces them on PendingInput; UI falls back to Yes/No when absent.
      trueLabel: input.trueLabel,
      falseLabel: input.falseLabel,
    };
  }
  return { ...base, ...p };
}

// Read an NDJSON Response body, yielding parsed lines as events.
async function* readNdjsonLines(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch (e) {
          // malformed line — skip with a console warning but keep stream alive
          console.warn("ndjson parse error on line:", line, e);
        }
      }
    }
    // Drain any partial line at the end
    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail);
      } catch {
        // ignore
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // reader may already be closed
    }
  }
}

async function* runStream({ templateIds, flowIds, campaignIds, signal, store, storeName, answerBroker, merchantSlug }) {
  const creds = store ?? {};
  const slug = merchantSlug || (storeName ?? "store").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "store";

  // 1. Create the job.
  let created;
  try {
    created = await postJsonStream("/api/jobs", {
      klaviyoKey: creds.klaviyoKey,
      storeId: creds.decodedStoreId,
      storeName: storeName ?? creds.name ?? slug,
      merchantSlug: slug,
      redoJwt: creds.redoToken,
      redoServerBase: creds.redoServerBase ?? undefined,
      templateIds: templateIds ?? [],
      flowIds: flowIds ?? [],
      campaignIds: campaignIds ?? [],
      runImport: true,
    });
  } catch (e) {
    yield { kind: "error", text: `create job: ${e instanceof Error ? e.message : String(e)}` };
    yield { kind: "done", importMethod: "rpc", imported: 0, importFailed: 0, flowsImported: 0, flowsFailed: 0, campaignsImported: 0, campaignsFailed: 0 };
    return;
  }
  const jobId = created.jobId;
  // Hand the server-assigned id back to the UI so it can swap out the
  // temporary client id (`j_${Date.now()}`) used while waiting for the
  // POST /api/jobs round trip. Without this the troubleshoot bundle and
  // notes endpoints 404 because they look up jobs by server id only.
  yield { kind: "_jobCreated", serverJobId: jobId };
  yield { kind: "info", text: `Job created: ${jobId.slice(0, 8)}…` };

  // 2. Open the stream. The server replays historical events + streams
  //    new ones until the job terminates or we abort.
  let response;
  try {
    response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/stream`, {
      signal,
      headers: { accept: "application/x-ndjson" },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`stream ${response.status}: ${text?.slice(0, 200) ?? response.statusText}`);
    }
  } catch (e) {
    yield { kind: "error", text: `stream open: ${e instanceof Error ? e.message : String(e)}` };
    yield { kind: "done", importMethod: "rpc", imported: 0, importFailed: 0, flowsImported: 0, flowsFailed: 0 };
    return;
  }

  // Track pending inputs so we can post answers back.
  const pendingInputIds = new Map(); // qid → backend input.id

  for await (const envelope of readNdjsonLines(response, signal)) {
    const evt = unwrapEvent(envelope);
    yield evt;

    // When a needs_input arrives, wait on the broker for the answer and
    // post it back to the server so the job can resume. The broker is a
    // Promise-based inbox populated by the UI's SetupInputModal submission.
    if (evt.kind === "needs_input" && evt.qid && evt._backendInputId) {
      pendingInputIds.set(evt.qid, evt._backendInputId);
      try {
        const answer = await answerBroker.waitFor(evt.qid);
        if (answer === "__skip__") {
          // No server-side "skip" today — submit a conservative default
          // (false / empty string) so the job unblocks + we surface a
          // warning via an info event.
          const skipAnswer = evt.type === "boolean" ? "false" : evt.default ?? "";
          await postJsonStream(`/api/jobs/${encodeURIComponent(jobId)}/inputs`, {
            inputId: evt._backendInputId,
            answer: skipAnswer,
          });
          yield { kind: "info", text: `Skipped "${evt.qid}" (applied default: ${JSON.stringify(skipAnswer)})` };
        } else {
          await postJsonStream(`/api/jobs/${encodeURIComponent(jobId)}/inputs`, {
            inputId: evt._backendInputId,
            answer: String(answer),
          });
        }
      } catch (e) {
        yield {
          kind: "warn",
          text: `Could not deliver answer for "${evt.qid}": ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }
  }
}

// Retry-a-single-item stream: creates a new backend job scoped to just
// the one failed item, streams events back. Caller wires them to the
// existing job's log so the retry appears in-place.
async function* retryStream({ id, name, kind, flow, store, storeName, answerBroker, merchantSlug, signal }) {
  const templateIds = kind === "template" ? [id] : [];
  const flowIds = kind === "flow" ? [id] : [];
  const campaignIds = kind === "campaign" ? [id] : [];
  yield* runStream({
    templateIds,
    flowIds,
    campaignIds,
    signal,
    store,
    storeName,
    answerBroker,
    merchantSlug,
  });
}

window.mockRunStream = runStream;
window.mockRetryStream = retryStream;
window.unwrapJobEvent = unwrapEvent;

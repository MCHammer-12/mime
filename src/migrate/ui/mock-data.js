// Per-store data cache + real API fetches. Replaces the seeded MOCK_DATA
// with fetched-on-demand flows + templates scoped to each store's Klaviyo key.
//
// Exports on window:
//   window.STORE_DATA              — { [storeId]: { flows, templates, state, error } }
//   window.fetchStoreData(store)   — Promise<{flows, templates}> — fetches + caches
//   window.MOCK_DATA               — back-compat: empty scaffolding with .flows / .templates
//                                     so old code paths that reference it don't crash
//   window.PRIOR_IMPORTED_FLOW_IDS — Set<string> (persisted across reloads via
//     localStorage under `redo.migrate.prior_imports.<storeId>`)
//   window.PRIOR_IMPORTED_TEMPLATE_IDS

const STORE_DATA = {};

async function postJson(path, body) {
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
    // fall through with null
  }
  if (!res.ok) {
    const msg = json?.error ?? text?.slice(0, 200) ?? res.statusText;
    throw new Error(`${path} ${res.status}: ${msg}`);
  }
  return json;
}

// Stream NDJSON from /api/flows/stream. Yields each parsed event object
// as it arrives. The server emits "started" → "discovered" → many
// "progress" events → terminal "done" (or "error") and then closes the
// connection.
async function* streamFlows(klaviyoKey) {
  const res = await fetch("/api/flows/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ klaviyoKey }),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`/api/flows/stream ${res.status}: ${text.slice(0, 200) || res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // NDJSON: split on \n, keep the trailing partial line in buf for the
    // next chunk.
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch (e) {
        console.warn("streamFlows: bad ndjson line", line.slice(0, 200));
      }
    }
  }
  // Flush any trailing line that didn't end with a newline (defensive).
  const tail = buf.trim();
  if (tail) {
    try { yield JSON.parse(tail); } catch {}
  }
}

// Fetch templates + flows + campaigns for a given store. Reports progress
// per section via the optional `onProgress({section, status, ...extra})`
// callback so the migration screen can render a live status panel during
// the (often 10-30s) catalog fetch instead of a featureless spinner.
//
// Sections + their status lifecycle:
//   templates  : loading → done | error
//   campaigns  : loading → done | error   (errors are non-fatal — we
//                continue without campaigns and surface the failure in
//                the panel)
//   flows      : loading → discovered (extra: total)
//                       → progress   (extra: scanned, total, currentName)
//                       → done | error
async function fetchStoreData(store, onProgress) {
  if (!store?.klaviyoKey) {
    throw new Error("store missing klaviyoKey");
  }
  const cacheKey = store.id;
  if (STORE_DATA[cacheKey]?.state === "loaded") {
    return STORE_DATA[cacheKey];
  }
  STORE_DATA[cacheKey] = {
    flows: [],
    templates: [],
    campaigns: [],
    state: "loading",
    error: null,
  };

  const report = (ev) => {
    try { onProgress?.(ev); } catch (e) { console.warn("onProgress threw", e); }
  };

  // Kick off all three sections concurrently. Each has its own progress
  // lifecycle. The function only resolves once templates + flows complete
  // (campaigns is best-effort).
  report({ section: "templates", status: "loading" });
  report({ section: "campaigns", status: "loading" });
  report({ section: "flows", status: "loading" });

  const templatesPromise = postJson("/api/templates", { klaviyoKey: store.klaviyoKey })
    .then((r) => { report({ section: "templates", status: "done", count: r?.templates?.length ?? 0 }); return r; })
    .catch((e) => { report({ section: "templates", status: "error", error: e?.message ?? String(e) }); throw e; });

  const campaignsPromise = postJson("/api/campaigns", { klaviyoKey: store.klaviyoKey })
    .then((r) => { report({ section: "campaigns", status: "done", count: r?.campaigns?.length ?? 0 }); return r; })
    .catch((e) => {
      // Campaigns are non-fatal — if the endpoint fails we still want
      // templates + flows to load. Log and return an empty list.
      console.warn("campaigns fetch failed:", e?.message ?? e);
      report({ section: "campaigns", status: "error", error: e?.message ?? String(e) });
      return { campaigns: [], debug: { error: String(e?.message ?? e) } };
    });

  const flowsPromise = (async () => {
    try {
      // Two-phase batched walk:
      //   1. /api/flows/list — fast paginate of flow metadata (~1-3s).
      //   2. /api/flows/walk-batch — walk N flows per request (~10-20s
      //      each), parallelised client-side.
      // We chunk the list and process several batches in parallel so
      // wall time stays close to the old single-stream design while
      // each individual HTTP request stays well under the proxy's hard
      // request-duration cap that was killing the long-lived stream.
      const listRes = await postJson("/api/flows/list", { klaviyoKey: store.klaviyoKey });
      const listed = listRes?.flows ?? [];
      report({ section: "flows", status: "discovered", total: listed.length });

      const BATCH_SIZE = 10;
      const PARALLEL_BATCHES = 3;
      const batches = [];
      for (let i = 0; i < listed.length; i += BATCH_SIZE) {
        batches.push(listed.slice(i, i + BATCH_SIZE));
      }

      const walked = [];
      const debugAgg = {
        totalFlows: listed.length,
        flowsWithActions: 0,
        flowsWithNoActions: 0,
        actionTypeCounts: {},
        messagesSeen: 0,
        messagesWithTemplate: 0,
        messagesWithoutTemplate: 0,
        failedActionFetches: 0,
        failedMessageFetches: 0,
        sampleFlowNames: [],
        sampleMessageFetchErrors: [],
      };
      const mergeDebug = (d) => {
        if (!d) return;
        debugAgg.flowsWithActions += d.flowsWithActions ?? 0;
        debugAgg.flowsWithNoActions += d.flowsWithNoActions ?? 0;
        debugAgg.messagesSeen += d.messagesSeen ?? 0;
        debugAgg.messagesWithTemplate += d.messagesWithTemplate ?? 0;
        debugAgg.messagesWithoutTemplate += d.messagesWithoutTemplate ?? 0;
        debugAgg.failedActionFetches += d.failedActionFetches ?? 0;
        debugAgg.failedMessageFetches += d.failedMessageFetches ?? 0;
        for (const [k, v] of Object.entries(d.actionTypeCounts ?? {})) {
          debugAgg.actionTypeCounts[k] = (debugAgg.actionTypeCounts[k] ?? 0) + v;
        }
        for (const n of d.sampleFlowNames ?? []) {
          if (debugAgg.sampleFlowNames.length < 10) debugAgg.sampleFlowNames.push(n);
        }
        for (const e of d.sampleMessageFetchErrors ?? []) {
          if (debugAgg.sampleMessageFetchErrors.length < 6) debugAgg.sampleMessageFetchErrors.push(e);
        }
      };

      // Walk a single batch with adaptive shrinking: on failure, split
      // it in half and retry each half. This way an individual slow flow
      // (or a transient 5xx) can't sink an otherwise-healthy 10-flow
      // batch — we just halve the request size until the chunks get
      // through, all the way down to single-flow requests if needed.
      async function walkBatchWithRetry(batch) {
        try {
          const res = await postJson("/api/flows/walk-batch", {
            klaviyoKey: store.klaviyoKey,
            flows: batch,
          });
          for (const w of res?.walked ?? []) walked.push(w);
          mergeDebug(res?.debug);
          return;
        } catch (e) {
          if (batch.length === 1) {
            // Single flow still failing — drop it but keep the rest of
            // the catalog. Surface in debug rather than aborting.
            debugAgg.failedActionFetches += 1;
            if (debugAgg.sampleMessageFetchErrors.length < 6) {
              debugAgg.sampleMessageFetchErrors.push(
                `flow ${batch[0]?.id ?? "?"} failed: ${e?.message?.slice(0, 120) ?? String(e).slice(0, 120)}`,
              );
            }
            return;
          }
          // Halve and recurse — keeps splitting until we either succeed
          // or isolate the bad flow at size 1.
          await new Promise(r => setTimeout(r, 800));
          const mid = Math.ceil(batch.length / 2);
          await walkBatchWithRetry(batch.slice(0, mid));
          await walkBatchWithRetry(batch.slice(mid));
        }
      }

      let scanned = 0;
      let nextBatch = 0;
      async function batchWorker() {
        while (nextBatch < batches.length) {
          const i = nextBatch++;
          const batch = batches[i];
          await walkBatchWithRetry(batch);
          scanned += batch.length;
          report({
            section: "flows",
            status: "progress",
            scanned: Math.min(scanned, listed.length),
            total: listed.length,
            currentName: batch[batch.length - 1]?.name ?? "",
          });
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(PARALLEL_BATCHES, batches.length) }, () => batchWorker()),
      );

      // Match server-side ordering: live → manual → draft → other, then by name
      const rank = (s) => s === "live" ? 0 : s === "manual" ? 1 : s === "draft" ? 2 : 3;
      walked.sort((a, b) => rank(a.flowStatus) - rank(b.flowStatus) || a.flowName.localeCompare(b.flowName));

      report({ section: "flows", status: "done", count: walked.length });
      // flowsTotal = everything Klaviyo listed (including SMS-only,
      // empty, and orphan-message flows). flows.length = the subset we
      // could actually find email content for. The UI surfaces the
      // delta so merchants understand why "77 discovered" can become
      // "53 selectable".
      return { flows: walked, flowsTotal: listed.length, debug: debugAgg };
    } catch (e) {
      report({ section: "flows", status: "error", error: e?.message ?? String(e) });
      throw e;
    }
  })();

  try {
    const [templatesRes, flowsRes, campaignsRes] = await Promise.all([
      templatesPromise,
      flowsPromise,
      campaignsPromise,
    ]);
    const loaded = {
      flows: flowsRes?.flows ?? [],
      flowsTotal: flowsRes?.flowsTotal ?? (flowsRes?.flows?.length ?? 0),
      templates: templatesRes?.templates ?? [],
      campaigns: campaignsRes?.campaigns ?? [],
      state: "loaded",
      error: null,
      debug: flowsRes?.debug ?? null,
      campaignsDebug: campaignsRes?.debug ?? null,
    };
    STORE_DATA[cacheKey] = loaded;
    return loaded;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    STORE_DATA[cacheKey] = {
      flows: [],
      templates: [],
      campaigns: [],
      state: "error",
      error,
    };
    throw e;
  }
}

// ─── Prior-imports persistence ────────────────────────────────────────────
// Track which items have been imported per store so the UI can show the
// "already imported" badge + filter across sessions. Keyed by storeId so a
// browser used by one operator across many merchants stays scoped correctly.

const PRIOR_FLOWS_KEY = (storeId) => `redo.migrate.prior_flows.${storeId}`;
const PRIOR_TMPLS_KEY = (storeId) => `redo.migrate.prior_tmpls.${storeId}`;
const PRIOR_CAMPAIGNS_KEY = (storeId) => `redo.migrate.prior_campaigns.${storeId}`;

function loadPriorImports(storeId) {
  if (!storeId) return { flows: new Set(), tmpls: new Set(), campaigns: new Set() };
  try {
    const flowsRaw = localStorage.getItem(PRIOR_FLOWS_KEY(storeId));
    const tmplsRaw = localStorage.getItem(PRIOR_TMPLS_KEY(storeId));
    const campaignsRaw = localStorage.getItem(PRIOR_CAMPAIGNS_KEY(storeId));
    return {
      flows: new Set(flowsRaw ? JSON.parse(flowsRaw) : []),
      tmpls: new Set(tmplsRaw ? JSON.parse(tmplsRaw) : []),
      campaigns: new Set(campaignsRaw ? JSON.parse(campaignsRaw) : []),
    };
  } catch {
    return { flows: new Set(), tmpls: new Set(), campaigns: new Set() };
  }
}

function savePriorImports(storeId, { flows, tmpls, campaigns }) {
  if (!storeId) return;
  try {
    localStorage.setItem(PRIOR_FLOWS_KEY(storeId), JSON.stringify([...(flows ?? [])]));
    localStorage.setItem(PRIOR_TMPLS_KEY(storeId), JSON.stringify([...(tmpls ?? [])]));
    localStorage.setItem(PRIOR_CAMPAIGNS_KEY(storeId), JSON.stringify([...(campaigns ?? [])]));
  } catch (e) {
    console.warn("savePriorImports: localStorage write failed", e);
  }
}

// Back-compat scaffolding — some components may still dereference MOCK_DATA
// during initial render before a store is selected. Empty arrays are safe.
window.MOCK_DATA = { flows: [], templates: [], debug: null };

// PRIOR_IMPORTED_* are populated lazily when a store is opened. Starting
// empty is fine — they fill in as fetchStoreData resolves + as imports
// complete during the session.
window.PRIOR_IMPORTED_FLOW_IDS = new Set();
window.PRIOR_IMPORTED_TEMPLATE_IDS = new Set();

window.STORE_DATA = STORE_DATA;
window.fetchStoreData = fetchStoreData;
window.loadPriorImports = loadPriorImports;
window.savePriorImports = savePriorImports;

// Re-fetch campaigns for a store with an optional created_at date range.
// since/until are "YYYY-MM-DD" (or null). Returns { campaigns, truncated, range }.
// Empty range → server falls back to the 10 most-recent.
window.reloadCampaigns = (store, { since, until } = {}) =>
  postJson("/api/campaigns", { klaviyoKey: store.klaviyoKey, since: since || undefined, until: until || undefined });

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
    let flows = [];
    let debug = null;
    try {
      for await (const ev of streamFlows(store.klaviyoKey)) {
        if (ev.kind === "discovered") {
          report({ section: "flows", status: "discovered", total: ev.total });
        } else if (ev.kind === "progress") {
          report({
            section: "flows",
            status: "progress",
            scanned: ev.scanned,
            total: ev.total,
            currentName: ev.currentName,
          });
        } else if (ev.kind === "done") {
          flows = ev.flows ?? [];
          debug = ev.debug ?? null;
        } else if (ev.kind === "error") {
          throw new Error(ev.error || "flows stream failed");
        }
      }
      report({ section: "flows", status: "done", count: flows.length });
      return { flows, debug };
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

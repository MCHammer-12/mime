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

// Fetch templates + flows in parallel for a given store. Returns normalized
// shapes matching what the existing components expect (same as the old
// MOCK_DATA structure).
async function fetchStoreData(store) {
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
    state: "loading",
    error: null,
  };

  try {
    const [templatesRes, flowsRes] = await Promise.all([
      postJson("/api/templates", { klaviyoKey: store.klaviyoKey }),
      postJson("/api/flows", { klaviyoKey: store.klaviyoKey }),
    ]);
    const loaded = {
      flows: flowsRes?.flows ?? [],
      templates: templatesRes?.templates ?? [],
      state: "loaded",
      error: null,
      debug: flowsRes?.debug ?? null,
    };
    STORE_DATA[cacheKey] = loaded;
    return loaded;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    STORE_DATA[cacheKey] = {
      flows: [],
      templates: [],
      state: "error",
      error,
    };
    throw e;
  }
}

// ─── Prior-imports persistence ────────────────────────────────────────────
// Track which items have been imported per store so the UI can show the
// green "already imported" state across sessions. Keyed by storeId.

const PRIOR_FLOWS_KEY = (storeId) => `redo.migrate.prior_flows.${storeId}`;
const PRIOR_TMPLS_KEY = (storeId) => `redo.migrate.prior_tmpls.${storeId}`;

function loadPriorImports(storeId) {
  if (!storeId) return { flows: new Set(), tmpls: new Set() };
  try {
    const flowsRaw = localStorage.getItem(PRIOR_FLOWS_KEY(storeId));
    const tmplsRaw = localStorage.getItem(PRIOR_TMPLS_KEY(storeId));
    return {
      flows: new Set(flowsRaw ? JSON.parse(flowsRaw) : []),
      tmpls: new Set(tmplsRaw ? JSON.parse(tmplsRaw) : []),
    };
  } catch {
    return { flows: new Set(), tmpls: new Set() };
  }
}

function savePriorImports(storeId, { flows, tmpls }) {
  if (!storeId) return;
  try {
    localStorage.setItem(PRIOR_FLOWS_KEY(storeId), JSON.stringify([...flows]));
    localStorage.setItem(PRIOR_TMPLS_KEY(storeId), JSON.stringify([...tmpls]));
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

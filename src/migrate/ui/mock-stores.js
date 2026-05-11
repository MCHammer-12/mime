// Store persistence + JWT audience decoding.
//
// Two backends:
//   - Server (POSTgres-backed) when GET /api/env reports `dbEnabled: true`.
//     Lets keys outlive a browser, lets diagnostic tooling read them
//     server-side, and lets a JWT be rotated in one place when it expires.
//   - localStorage fallback for local dev without DATABASE_URL.
//
// Either way the components see `window.MOCK_STORES` (initial array) and
// the same `saveStores`, `addStore`, `updateStore`, `deleteStore` exports.
// The only difference: the server-backed versions are async and the UI
// awaits them on mount via `window.refreshStores()`.
//
// Exports on window:
//   window.MOCK_STORES              — initial array (sync, may be empty
//                                     until refreshStores resolves)
//   window.refreshStores()          — pulls fresh list from server (no-op
//                                     for localStorage)
//   window.addStore(input)          — returns the created store
//   window.updateStore(id, patch)   — returns the updated store
//   window.deleteStore(id)
//   window.decodeStoreIdFromToken() — base64url-decodes a JWT and reads aud
//   window.saveStores(stores)       — legacy: bulk write (localStorage only)
//   window.makeAnswerBroker()       — promise broker for needs_input answers

const LS_KEY = "redo.migrate.stores";

// ─── JWT audience decode ───────────────────────────────────────────────────

function b64uToBytes(s) {
  let pad = s.length % 4;
  if (pad === 2) s += "==";
  else if (pad === 3) s += "=";
  else if (pad === 1) throw new Error("invalid base64url");
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeStoreIdFromToken(token) {
  if (!token) return null;
  const t = token.trim();
  if (t.length < 10) return null;
  if (t.startsWith("redo_pat_")) return null;
  const parts = t.split(".");
  if (parts.length !== 3) return null;
  try {
    const payloadBytes = b64uToBytes(parts[1]);
    const payloadStr = new TextDecoder().decode(payloadBytes);
    const payload = JSON.parse(payloadStr);
    return (
      payload.aud ??
      payload.teamId ??
      payload.team_id ??
      payload.sub ??
      null
    );
  } catch {
    return null;
  }
}

// Decode a JWT's exp claim → ms epoch, or null when the token isn't a JWT
// or has no exp field. Used by the credentials editor to surface
// "expires in 12 min" hints next to the JWT field.
function decodeJwtExp(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(b64uToBytes(parts[1])),
    );
    if (typeof payload.exp !== "number") return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

// ─── Backend selection ─────────────────────────────────────────────────────

let backend = "localStorage"; // flips to "server" after detectBackend() resolves

async function detectBackend() {
  try {
    const r = await fetch("/api/env");
    if (!r.ok) return;
    const env = await r.json();
    if (env.dbEnabled === true) backend = "server";
  } catch {
    // Network hiccup — keep localStorage default. The UI can refresh
    // later once /api/env is reachable.
  }
}

// ─── localStorage backend ──────────────────────────────────────────────────

function loadStoresFromLocalStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function saveStoresToLocalStorage(stores) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(stores));
  } catch (e) {
    console.warn("saveStores: localStorage write failed", e);
  }
}

// ─── Server backend ────────────────────────────────────────────────────────

// The server returns a "summary" shape for list (masked keys, no JWT
// content) and a full record for getById. Components need the same field
// shape regardless of backend, so we normalize: the list response stays
// masked (UI only displays the picker) and the full record is fetched
// lazily when the edit form opens.
async function fetchStoreList() {
  const r = await fetch("/api/stores");
  if (!r.ok) throw new Error(`/api/stores ${r.status}`);
  const { stores } = await r.json();
  // Map summary → component-friendly shape. `klaviyoKey` / `redoToken`
  // intentionally absent here — components must call `fetchStoreById`
  // before showing them.
  return stores.map((s) => ({
    id: s.id,
    name: s.name,
    merchantSlug: s.merchantSlug,
    decodedStoreId: s.storeId,
    redoServerBase: s.redoServerBase,
    // Pass through the creator so the dashboard's Mine/All filter can
    // match against currentUser. Stores from before migration 007 will
    // have createdBy === null and only show under All.
    createdBy: s.createdBy ?? null,
    createdAt: s.createdAt ? Date.parse(s.createdAt) : null,
    lastImportedAt: s.lastImportedAt ? Date.parse(s.lastImportedAt) : null,
    // Mask hints for the picker tile
    klaviyoKeyMasked: s.klaviyoKeyMasked,
    redoJwtMasked: s.redoJwtMasked,
    hasRedoJwt: s.hasRedoJwt,
    jwtExpiresAt: s.jwtExpiresAt ? Date.parse(s.jwtExpiresAt) : null,
  }));
}

async function fetchStoreById(id) {
  const r = await fetch(`/api/stores/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`/api/stores/${id} ${r.status}`);
  const { store } = await r.json();
  return {
    id: store.id,
    name: store.name,
    merchantSlug: store.merchantSlug,
    klaviyoKey: store.klaviyoKey,
    redoToken: store.redoJwt ?? "",
    decodedStoreId: store.storeId,
    redoServerBase: store.redoServerBase,
    createdAt: store.createdAt ? Date.parse(store.createdAt) : null,
    lastImportedAt: store.lastImportedAt ? Date.parse(store.lastImportedAt) : null,
  };
}

async function createStoreOnServer(input) {
  const body = {
    name: input.name,
    merchantSlug: input.merchantSlug || input.name,
    klaviyoKey: input.klaviyoKey,
    storeId: input.decodedStoreId,
    redoJwt: input.redoToken || null,
    redoServerBase: input.redoServerBase ?? null,
  };
  const r = await fetch("/api/stores", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || `/api/stores ${r.status}`);
  }
  const { store } = await r.json();
  return store;
}

async function updateStoreOnServer(id, patch) {
  // Map UI-side field names → server field names.
  const body = {};
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.merchantSlug !== undefined) body.merchantSlug = patch.merchantSlug;
  if (patch.klaviyoKey !== undefined) body.klaviyoKey = patch.klaviyoKey;
  if (patch.redoToken !== undefined) body.redoJwt = patch.redoToken;
  if (patch.decodedStoreId !== undefined) body.storeId = patch.decodedStoreId;
  if (patch.redoServerBase !== undefined) body.redoServerBase = patch.redoServerBase;
  const r = await fetch(`/api/stores/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || `/api/stores/${id} ${r.status}`);
  }
  const { store } = await r.json();
  return store;
}

async function deleteStoreOnServer(id) {
  const r = await fetch(`/api/stores/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!r.ok && r.status !== 404) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || `/api/stores/${id} ${r.status}`);
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

async function refreshStores() {
  if (backend === "server") {
    try {
      const list = await fetchStoreList();
      window.MOCK_STORES = list;
      // Notify React listeners that the array reference changed.
      window.dispatchEvent(new CustomEvent("stores:refreshed", { detail: list }));
      return list;
    } catch (e) {
      console.warn("refreshStores: server fetch failed", e);
      return window.MOCK_STORES;
    }
  }
  // localStorage backend doesn't need a refresh — the array in memory is
  // the source of truth. Re-emit anyway so callers don't have to branch.
  return window.MOCK_STORES;
}

async function addStore(input) {
  if (backend === "server") {
    const created = await createStoreOnServer(input);
    await refreshStores();
    return {
      id: created.id,
      name: created.name,
      merchantSlug: created.merchantSlug,
      klaviyoKey: created.klaviyoKey,
      redoToken: created.redoJwt ?? "",
      decodedStoreId: created.storeId,
      redoServerBase: created.redoServerBase,
      createdAt: created.createdAt ? Date.parse(created.createdAt) : Date.now(),
      lastImportedAt: null,
    };
  }
  // localStorage path — preserve the legacy shape exactly.
  const newStore = {
    id: input.id ?? `str_${Date.now().toString(36)}`,
    name: input.name,
    merchantSlug: input.merchantSlug ?? input.name,
    klaviyoKey: input.klaviyoKey,
    redoToken: input.redoToken,
    decodedStoreId: input.decodedStoreId,
    redoServerBase: input.redoServerBase ?? null,
    createdAt: Date.now(),
    lastImportedAt: null,
  };
  const next = [...window.MOCK_STORES, newStore];
  window.MOCK_STORES = next;
  saveStoresToLocalStorage(next);
  return newStore;
}

async function updateStore(id, patch) {
  if (backend === "server") {
    const updated = await updateStoreOnServer(id, patch);
    await refreshStores();
    return {
      id: updated.id,
      name: updated.name,
      merchantSlug: updated.merchantSlug,
      klaviyoKey: updated.klaviyoKey,
      redoToken: updated.redoJwt ?? "",
      decodedStoreId: updated.storeId,
      redoServerBase: updated.redoServerBase,
      createdAt: updated.createdAt ? Date.parse(updated.createdAt) : null,
      lastImportedAt: updated.lastImportedAt ? Date.parse(updated.lastImportedAt) : null,
    };
  }
  const next = window.MOCK_STORES.map((s) =>
    s.id === id ? { ...s, ...patch } : s,
  );
  window.MOCK_STORES = next;
  saveStoresToLocalStorage(next);
  return next.find((s) => s.id === id) ?? null;
}

async function deleteStore(id) {
  if (backend === "server") {
    await deleteStoreOnServer(id);
    await refreshStores();
    return;
  }
  const next = window.MOCK_STORES.filter((s) => s.id !== id);
  window.MOCK_STORES = next;
  saveStoresToLocalStorage(next);
}

// Legacy bulk-write entrypoint — used by app.jsx's saveStores branch.
// Server backend is event-driven (per-mutation calls), so this is a no-op
// there; for localStorage it writes through.
function saveStores(stores) {
  if (backend === "server") {
    // The server is already authoritative — accept the in-memory cache
    // update but don't write through.
    window.MOCK_STORES = stores;
    return;
  }
  window.MOCK_STORES = stores;
  saveStoresToLocalStorage(stores);
}

// ─── needs_input broker (unchanged) ────────────────────────────────────────

function makeAnswerBroker() {
  const answered = new Map();
  const pending = new Map();
  return {
    submit(qid, answer, applyAll) {
      if (applyAll) answered.set(qid, answer);
      const resolve = pending.get(qid);
      if (resolve) {
        pending.delete(qid);
        resolve(answer);
      }
    },
    async waitFor(qid) {
      if (answered.has(qid)) return answered.get(qid);
      return new Promise((resolve) => pending.set(qid, resolve));
    },
  };
}

// ─── Boot ──────────────────────────────────────────────────────────────────
// Always start with whatever's in localStorage so first paint isn't empty.
// detectBackend() then flips to server-mode and refreshStores() pulls the
// canonical list, which dispatches a `stores:refreshed` event for React.

window.MOCK_STORES = loadStoresFromLocalStorage();
window.decodeStoreIdFromToken = decodeStoreIdFromToken;
window.decodeJwtExp = decodeJwtExp;
window.saveStores = saveStores;
window.refreshStores = refreshStores;
window.addStore = addStore;
window.updateStore = updateStore;
window.deleteStore = deleteStore;
window.fetchStoreById = fetchStoreById;
window.makeAnswerBroker = makeAnswerBroker;

detectBackend().then(() => {
  if (backend === "server") refreshStores();
});

// Store persistence + JWT audience decoding. Replaces the mock seed data
// with localStorage-backed store records that survive page reloads.
//
// Exports on window (consumed by components unchanged):
//   window.MOCK_STORES              — Array<StoreRecord>
//   window.decodeStoreIdFromToken() — base64url-decodes a JWT and reads aud
//   window.saveStores(stores)       — persist array back to localStorage
//   window.makeAnswerBroker()       — promise broker for needs_input answers

const LS_KEY = "redo.migrate.stores";

// base64url → Uint8Array, tolerant of padding omission.
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

// Decode a JWT payload and return the `aud` claim. Returns null if the
// token doesn't look like a JWT (e.g. it's a redo_pat_* API token), in
// which case the caller falls back to a manual Store-ID input.
function decodeStoreIdFromToken(token) {
  if (!token) return null;
  const t = token.trim();
  if (t.length < 10) return null;
  if (t.startsWith("redo_pat_")) return null; // PAT: aud not embedded
  const parts = t.split(".");
  if (parts.length !== 3) return null;
  try {
    const payloadBytes = b64uToBytes(parts[1]);
    const payloadStr = new TextDecoder().decode(payloadBytes);
    const payload = JSON.parse(payloadStr);
    // The Redo JWT schema uses `aud` for the team/store ObjectId. Some
    // tokens may carry it under `teamId` or inside a nested claim.
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

function saveStores(stores) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(stores));
  } catch (e) {
    console.warn("saveStores: localStorage write failed", e);
  }
}

// ─── needs_input broker ────────────────────────────────────────────────────
// The async-generator pipeline emits a `needs_input` event and awaits the
// user's answer. The broker lets the modal submit an answer which resolves
// a promise the stream is blocked on. Also caches answers by qid so
// repeated questions in the same run reuse the answer automatically
// (matches the backend's questionKey behavior).

function makeAnswerBroker() {
  const answered = new Map(); // qid → answer
  const pending = new Map(); // qid → resolve
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

// Kick off with whatever's in localStorage. An empty array is fine — the
// dashboard has an "Add store" tile that walks the user through setup.
window.MOCK_STORES = loadStoresFromLocalStorage();
window.decodeStoreIdFromToken = decodeStoreIdFromToken;
window.saveStores = saveStores;
window.makeAnswerBroker = makeAnswerBroker;

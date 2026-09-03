// Mock store data + JWT audience decoding.

// Fake-decode a Redo auth token. Real impl would base64-decode the JWT
// middle segment and read `aud`. Here we accept any string and return
// a deterministic fake store id based on its hash.
function decodeStoreIdFromToken(token) {
  if (!token || token.length < 10) return null;
  let h = 0;
  for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) & 0xffffffff;
  const hex = Math.abs(h).toString(16).padStart(8, "0");
  return `store_${hex}${"0".repeat(16)}`.slice(0, 24);
}

const MOCK_STORES = [
  {
    id: "str_aj",
    name: "Alexander Jane",
    klaviyoKey: "pk_7f3a9c2e1b4d8a6f5e9c3b7d2a1f4e8c9b",
    redoToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdG9yZSI6InN0b3JlXzdhM2YiLCJleHAiOjE3NjIzMjB9.a7f3e9c2b1d4f8a6",
    decodedStoreId: "69dff28302f64f42e6012a4d",
    createdAt: Date.now() - 14 * 86400_000,
    lastImportedAt: Date.now() - 2 * 3600_000,
  },
  {
    id: "str_oti",
    name: "Otishi Wellness",
    klaviyoKey: "pk_2a8d1f3e9c7b5a4d2f1e6c8b9a3d5e7f2",
    redoToken: "eyJhbGciOiJIUzI1NiJ9.eyJzdG9yZSI6InN0b3JlXzJhOGQifQ.placeholder",
    decodedStoreId: "71aae38502f64f42e6034b1c",
    createdAt: Date.now() - 6 * 86400_000,
    lastImportedAt: Date.now() - 26 * 3600_000,
  },
  {
    id: "str_nord",
    name: "Nord Coffee Co.",
    klaviyoKey: "pk_4c1e7b9d3a5f2e8c6b4d1a9e3c7f5b2d8",
    redoToken: "eyJhbGciOiJIUzI1NiJ9.eyJzdG9yZSI6InN0b3JlXzRjMWUifQ.placeholder",
    decodedStoreId: "8a2bc49611f74d55f2019fa7d",
    createdAt: Date.now() - 1 * 86400_000,
    lastImportedAt: null,
  },
];

window.MOCK_STORES = MOCK_STORES;
window.decodeStoreIdFromToken = decodeStoreIdFromToken;

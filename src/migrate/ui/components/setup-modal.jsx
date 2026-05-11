// Add/Edit-store modal — three-field form. Decodes store ID from Redo
// token on save. Token field always asks for the Redo session JWT (same
// in dev + prod).
//
// Modes:
//   - Add (default): name + key + JWT all required.
//   - Edit (when `initialStore` is passed): inputs pre-populate from the
//     existing record. JWT field can be re-pasted to rotate when expired;
//     leaving it blank keeps the prior value. Showing exp time helps the
//     user know whether a rotation is needed.

const { useState: useSM, useEffect: useEM } = React;

function SetupModal({ onSave, onClose, initialStore }) {
  const isEdit = Boolean(initialStore);

  const [name, setName] = useSM(initialStore?.name ?? "");
  const [klaviyoKey, setKlaviyoKey] = useSM(initialStore?.klaviyoKey ?? "");
  const [redoToken, setRedoToken] = useSM(initialStore?.redoToken ?? "");
  const [redoServerBase, setRedoServerBase] = useSM(initialStore?.redoServerBase ?? "");
  const [showAdvanced, setShowAdvanced] = useSM(Boolean(initialStore?.redoServerBase));
  const [hydrating, setHydrating] = useSM(false);

  // For edit mode the parent may have only passed a masked listing entry.
  // Pull the unmasked record once on mount.
  useEM(() => {
    if (!isEdit || !initialStore?.id) return;
    if (initialStore.klaviyoKey) return; // already hydrated
    if (typeof window.fetchStoreById !== "function") return;
    setHydrating(true);
    window
      .fetchStoreById(initialStore.id)
      .then((rec) => {
        if (rec.klaviyoKey && !klaviyoKey) setKlaviyoKey(rec.klaviyoKey);
        if (rec.redoToken && !redoToken) setRedoToken(rec.redoToken);
        if (rec.name && !name) setName(rec.name);
        if (rec.redoServerBase && !redoServerBase) setRedoServerBase(rec.redoServerBase);
      })
      .finally(() => setHydrating(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, initialStore?.id]);

  const decoded = window.decodeStoreIdFromToken(redoToken)
    ?? initialStore?.decodedStoreId
    ?? null;

  // JWT exp surface — helps the user decide whether the token even needs
  // re-pasting before they hit save, and blocks Add mode when expired.
  const jwtExpMs = redoToken ? window.decodeJwtExp?.(redoToken) : null;
  const jwtExpired = jwtExpMs && jwtExpMs < Date.now();
  const jwtMinutesLeft = jwtExpMs && !jwtExpired
    ? Math.round((jwtExpMs - Date.now()) / 60000)
    : null;

  // Edit mode: name + klaviyo key required, JWT optional (blank = "keep
  // existing"; if a new value is pasted it must not be expired).
  // Add mode: all three required, and the JWT must decode AND not be expired.
  const tokenOk = !redoToken.trim() || (decoded && !jwtExpired);
  const valid = isEdit
    ? Boolean(name.trim() && klaviyoKey.trim().length > 10 && tokenOk)
    : Boolean(name.trim() && klaviyoKey.trim().length > 10 && decoded && !jwtExpired);

  const inputClass =
    "w-full bg-[#010409] border border-[#30363d] rounded-[4px] " +
    "px-2.5 py-2 text-[13px] text-[#e6edf3] " +
    "placeholder:text-[#484f58] focus:outline-none focus:border-[#388bfd]";

  return (
    <div className="fixed inset-0 z-50 bg-[#010409cc] backdrop-blur-sm flex items-center justify-center px-4">
      <div className="w-full max-w-[460px] bg-[#0d1117] border border-[#30363d] rounded-[6px] shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#21262d]">
          <h2 className="font-serif text-[22px] leading-none text-[#e6edf3]">
            {isEdit ? "Edit credentials" : "Add store"}
          </h2>
          <button onClick={onClose} className="text-[#6e7681] hover:text-[#e6edf3]">
            <Icon.x width="14" height="14"/>
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {hydrating && (
            <div className="text-[11px] text-[#8b949e]">Loading current values…</div>
          )}
          <label className="block">
            <div className="text-[11px] text-[#8b949e] mb-1.5">Store name</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Acme Co."
              className={inputClass}
              autoFocus={!isEdit}
            />
            <div className="text-[10px] text-[#6e7681] mt-1">Merchant-facing name. Shows on the dashboard.</div>
          </label>

          <label className="block">
            <div className="text-[11px] text-[#8b949e] mb-1.5">Klaviyo key</div>
            <input
              type="text"
              value={klaviyoKey}
              onChange={(e) => setKlaviyoKey(e.target.value)}
              placeholder="pk_abc123def456…"
              className={inputClass + " font-mono text-[12px]"}
              spellCheck={false}
              autoComplete="off"
            />
          </label>

          <label className="block">
            <div className="text-[11px] text-[#8b949e] mb-1.5">
              Redo session token
              {jwtExpired && (
                <span className="ml-2 text-[#f85149]">expired — paste fresh</span>
              )}
              {!jwtExpired && jwtMinutesLeft !== null && (
                <span className="ml-2 text-[#8b949e]">expires in {jwtMinutesLeft} min</span>
              )}
            </div>
            <input
              type="text"
              value={redoToken}
              onChange={(e) => setRedoToken(e.target.value)}
              placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…"
              className={inputClass + " font-mono text-[12px]"}
              spellCheck={false}
              autoComplete="off"
            />
            <div className="text-[10px] text-[#6e7681] mt-1.5 leading-relaxed">
              Paste the JWT from your browser. In Chrome: open{" "}
              <code className="text-[#8b949e]">app.getredo.com</code> while logged in,
              DevTools → Application → Local Storage → copy the value of{" "}
              <code className="text-[#8b949e]">redo.merchant_auth_token.&lt;teamId&gt;</code>.
              Expires periodically; re-paste if you get a 401.
            </div>
            {decoded && !jwtExpired && (
              <div className="text-[10px] text-[#3fb950] mt-1.5 font-mono flex items-center gap-1.5">
                <Icon.check width="10" height="10"/>
                Store ID: {decoded.slice(0, 20)}…
              </div>
            )}
            {decoded && jwtExpired && (
              <div className="text-[10px] text-[#f85149] mt-1.5">
                Token has expired — re-paste a fresh one.
              </div>
            )}
            {redoToken.trim() && !decoded && (
              <div className="text-[10px] text-[#f85149] mt-1.5">
                Couldn't read the store ID from this token. Make sure it's the JWT
                from <code className="text-[#8b949e]">redo.merchant_auth_token.&lt;teamId&gt;</code>{" "}
                (starts with <code className="text-[#8b949e]">eyJ</code>).
              </div>
            )}
          </label>

          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((s) => !s)}
              className="text-[11px] text-[#6e7681] hover:text-[#e6edf3] flex items-center gap-1"
            >
              <span>{showAdvanced ? "▾" : "▸"}</span>
              <span>Advanced: Redo server URL</span>
            </button>
            {showAdvanced && (
              <label className="block mt-2">
                <div className="text-[11px] text-[#8b949e] mb-1.5">
                  Redo server URL <span className="text-[#6e7681]">(optional)</span>
                </div>
                <input
                  value={redoServerBase}
                  onChange={(e) => setRedoServerBase(e.target.value)}
                  placeholder="https://app-server.getredo.com"
                  className={inputClass + " font-mono text-[12px]"}
                  spellCheck={false}
                />
                <div className="text-[10px] text-[#6e7681] mt-1.5 leading-relaxed">
                  Leave blank to import into production Redo. For testing
                  against a locally-running redoapp, expose it via ngrok /
                  Cloudflare tunnel and paste the public URL here.
                </div>
              </label>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#21262d] bg-[#010409]">
          <button
            onClick={onClose}
            className="text-[12px] text-[#8b949e] hover:text-[#e6edf3] px-3 py-1.5"
          >Cancel</button>
          <button
            onClick={() => valid && onSave({
              id: initialStore?.id,
              name: name.trim(),
              klaviyoKey: klaviyoKey.trim(),
              // In edit mode, an empty token means "keep existing" so we
              // omit the field from the patch. Trimmed token is required
              // in add mode.
              ...(redoToken.trim()
                ? { redoToken: redoToken.trim() }
                : {}),
              decodedStoreId: decoded,
              redoServerBase: redoServerBase.trim() || null,
            })}
            disabled={!valid}
            className="text-[12px] font-medium text-white bg-[#238636] hover:bg-[#2ea043] disabled:bg-[#21262d] disabled:text-[#6e7681] disabled:cursor-not-allowed px-3 py-1.5 rounded-[4px] border border-[#2ea043] disabled:border-[#30363d]"
          >{isEdit ? "Save changes" : "Add store"}</button>
        </div>
      </div>
    </div>
  );
}

window.SetupModal = SetupModal;

// Add-store modal — three-field form. Decodes store ID from Redo token on save.
// Token field always asks for the Redo session JWT (same in dev + prod).

const { useState: useSM } = React;

function SetupModal({ onSave, onClose }) {
  const [name, setName] = useSM("");
  const [klaviyoKey, setKlaviyoKey] = useSM("");
  const [redoToken, setRedoToken] = useSM("");
  const [redoServerBase, setRedoServerBase] = useSM("");
  const [showAdvanced, setShowAdvanced] = useSM(false);

  const decoded = window.decodeStoreIdFromToken(redoToken);
  const valid = name.trim() && klaviyoKey.trim().length > 10 && decoded;

  const inputClass =
    "w-full bg-[#010409] border border-[#30363d] rounded-[4px] " +
    "px-2.5 py-2 text-[13px] text-[#e6edf3] " +
    "placeholder:text-[#484f58] focus:outline-none focus:border-[#388bfd]";

  return (
    <div className="fixed inset-0 z-50 bg-[#010409cc] backdrop-blur-sm flex items-center justify-center px-4">
      <div className="w-full max-w-[460px] bg-[#0d1117] border border-[#30363d] rounded-[6px] shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#21262d]">
          <h2 className="font-serif text-[22px] leading-none text-[#e6edf3]">Add store</h2>
          <button onClick={onClose} className="text-[#6e7681] hover:text-[#e6edf3]">
            <Icon.x width="14" height="14"/>
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <label className="block">
            <div className="text-[11px] text-[#8b949e] mb-1.5">Store name</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Acme Co."
              className={inputClass}
              autoFocus
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
            <div className="flex items-baseline justify-between mb-1.5">
              <div className="text-[11px] text-[#8b949e]">
                Redo session token
              </div>
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
            {decoded && (
              <div className="text-[10px] text-[#3fb950] mt-1.5 font-mono flex items-center gap-1.5">
                <Icon.check width="10" height="10"/>
                Store ID decoded: {decoded.slice(0, 20)}…
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
              name: name.trim(),
              klaviyoKey: klaviyoKey.trim(),
              redoToken: redoToken.trim(),
              decodedStoreId: decoded,
              redoServerBase: redoServerBase.trim() || null,
            })}
            disabled={!valid}
            className="text-[12px] font-medium text-white bg-[#238636] hover:bg-[#2ea043] disabled:bg-[#21262d] disabled:text-[#6e7681] disabled:cursor-not-allowed px-3 py-1.5 rounded-[4px] border border-[#2ea043] disabled:border-[#30363d]"
          >Add store</button>
        </div>
      </div>
    </div>
  );
}

window.SetupModal = SetupModal;

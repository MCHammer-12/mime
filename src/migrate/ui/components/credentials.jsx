// Top credentials bar — compact, always visible, collapses to a summary
// once filled in. Designed for an engineer who pastes 3 values, hits Tab,
// and never wants to see this area again.

const { useState: useStateCreds } = React;

function CredentialsBar({ creds, onChange }) {
  const [expanded, setExpanded] = useStateCreds(!creds.filled);
  const [show, setShow] = useStateCreds({ klaviyo: false, jwt: false });

  const allFilled = creds.klaviyoKey && creds.redoJwt && creds.storeId;

  const inputClass =
    "w-full bg-[#010409] border border-[#30363d] rounded-[4px] " +
    "px-2.5 py-1.5 text-[12px] font-mono text-[#e6edf3] " +
    "placeholder:text-[#484f58] focus:outline-none focus:border-[#388bfd]";

  const mask = (v, visible) => {
    if (!v) return "—";
    if (visible) return v;
    return v.slice(0, 4) + "…" + v.slice(-4);
  };

  if (!expanded && allFilled) {
    return (
      <div className="flex items-center gap-6 px-4 py-2 border-b border-[#21262d] bg-[#010409] text-[11px] font-mono text-[#8b949e]">
        <span className="text-[#6e7681] uppercase tracking-wider text-[10px]">creds</span>
        <span>klaviyo <span className="text-[#e6edf3]">{mask(creds.klaviyoKey, false)}</span></span>
        <span>jwt <span className="text-[#e6edf3]">{mask(creds.redoJwt, false)}</span></span>
        <span>store <span className="text-[#e6edf3]">{creds.storeId}</span></span>
        <span>slug <span className="text-[#e6edf3]">{creds.merchantSlug || "—"}</span></span>
        <button
          onClick={() => setExpanded(true)}
          className="ml-auto text-[#388bfd] hover:underline"
        >edit</button>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 border-b border-[#21262d] bg-[#010409]">
      <div className="grid grid-cols-[1fr_1fr_180px_180px_auto] gap-3 items-end">
        <Field label="Klaviyo API key" hint="pk_*">
          <input
            type="text"
            value={creds.klaviyoKey}
            onChange={(e) => onChange({ ...creds, klaviyoKey: e.target.value })}
            placeholder="pk_abc123def456…"
            className={inputClass}
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
        <Field label="Redo JWT">
          <div className="relative">
            <input
              type={show.jwt ? "text" : "password"}
              value={creds.redoJwt}
              onChange={(e) => onChange({ ...creds, redoJwt: e.target.value })}
              placeholder="eyJhbGciOiJIUzI1…"
              className={inputClass + " pr-7"}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              onClick={() => setShow(s => ({ ...s, jwt: !s.jwt }))}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[#6e7681] hover:text-[#e6edf3]"
              tabIndex={-1}
            >
              {show.jwt
                ? <Icon.eyeOff width="14" height="14"/>
                : <Icon.eye width="14" height="14"/>}
            </button>
          </div>
        </Field>
        <Field label="Redo store ID">
          <input
            value={creds.storeId}
            onChange={(e) => onChange({ ...creds, storeId: e.target.value })}
            placeholder="store_7a3f…"
            className={inputClass}
            spellCheck={false}
          />
        </Field>
        <Field label="Merchant slug" hint="optional">
          <input
            value={creds.merchantSlug}
            onChange={(e) => onChange({ ...creds, merchantSlug: e.target.value })}
            placeholder="acme-co"
            className={inputClass}
            spellCheck={false}
          />
        </Field>
        <div className="pb-0.5">
          {allFilled && (
            <button
              onClick={() => setExpanded(false)}
              className="text-[11px] px-3 py-1.5 text-[#8b949e] hover:text-[#e6edf3]"
            >collapse</button>
          )}
        </div>
      </div>
      {!allFilled && (
        <div className="mt-2 text-[11px] text-[#8b949e] flex items-center gap-2">
          <Icon.alert width="12" height="12" className="text-[#d29922]"/>
          Paste credentials to load flows &amp; templates.
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-wider text-[#6e7681] mb-1 flex gap-1.5 items-center">
        <span>{label}</span>
        {hint && <span className="text-[#484f58] normal-case tracking-normal">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

window.CredentialsBar = CredentialsBar;

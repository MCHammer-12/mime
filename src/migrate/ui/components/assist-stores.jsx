// Brand-card grid for the assist view. Search + Mine/All filter at the
// top; cards gray out when the requesting assistant (?as=) has checked
// off every item for that brand.

const { useState: useSAS, useMemo: useMAS } = React;

function AssistStores({ stores, loading, author, onOpenStore }) {
  const [query, setQuery] = useSAS("");
  // Default to "mine" when the URL identifies an assistant; without one
  // there's nothing to scope to so default to "all".
  const [scope, setScope] = useSAS(author ? "mine" : "all");

  const filtered = useMAS(() => {
    const q = query.trim().toLowerCase();
    return stores
      .filter(s => {
        if (scope === "mine" && !s.myEngaged && !s.mineComplete) return false;
        if (q && !s.storeName.toLowerCase().includes(q)) return false;
        return true;
      });
  }, [stores, query, scope]);

  const totalLabel = loading
    ? "Loading…"
    : stores.length === 0
      ? "Nothing imported yet."
      : `${filtered.length} of ${stores.length} brand${stores.length === 1 ? "" : "s"}`;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1200px] mx-auto px-8 py-8">
        <div className="flex items-baseline justify-between mb-4">
          <div>
            <h1 className="font-serif text-[40px] leading-[1] tracking-tight text-[#e6edf3]">Brands</h1>
            <p className="text-[12px] text-[#8b949e] mt-2">{totalLabel}</p>
          </div>
        </div>

        {stores.length > 0 && (
          <div className="flex items-center gap-2 mb-4">
            <div className="relative flex-1 max-w-[420px]">
              <Icon.search
                width="14"
                height="14"
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#6e7681]"
              />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search brands…"
                className="w-full bg-[#010409] border border-[#21262d] focus:border-[#388bfd] outline-none rounded-[4px] pl-8 pr-3 py-1.5 text-[12px] text-[#e6edf3] placeholder:text-[#484f58]"
              />
            </div>
            {author && (
              <div className="flex items-center gap-1 text-[11px]">
                <ScopeButton active={scope === "mine"} onClick={() => setScope("mine")}>
                  Mine
                </ScopeButton>
                <ScopeButton active={scope === "all"} onClick={() => setScope("all")}>
                  All
                </ScopeButton>
              </div>
            )}
          </div>
        )}

        {filtered.length === 0 && stores.length > 0 && !loading && (
          <div className="text-[12px] text-[#6e7681] py-8 text-center border border-dashed border-[#30363d] rounded-[6px]">
            No brands match.
          </div>
        )}

        {filtered.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {filtered.map(store => (
              <AssistStoreCard
                key={store.storeId}
                store={store}
                onClick={() => onOpenStore(store.storeId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ScopeButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={
        "px-2.5 py-1 rounded-[4px] border transition-colors " +
        (active
          ? "bg-[#21262d] border-[#388bfd] text-[#e6edf3]"
          : "bg-transparent border-[#21262d] text-[#8b949e] hover:border-[#30363d] hover:text-[#e6edf3]")
      }
    >
      {children}
    </button>
  );
}

function AssistStoreCard({ store, onClick }) {
  const dim = store.mineComplete;
  return (
    <button
      onClick={onClick}
      className={
        "text-left border rounded-[6px] p-4 transition-colors bg-[#0d1117] " +
        (dim
          ? "border-[#21262d] hover:border-[#30363d] opacity-50"
          : "border-[#21262d] hover:border-[#30363d]")
      }
      title={dim ? "All items checked off" : undefined}
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <div className="font-serif text-[22px] leading-[1.1] text-[#e6edf3] truncate">
            {store.storeName}
          </div>
          <div className="text-[11px] text-[#6e7681] mt-1">
            Last imported {relDate(store.lastImportedAt)} ago
          </div>
        </div>
        <div className="flex-shrink-0">
          {dim
            ? <Icon.check width="14" height="14" className="text-[#3fb950]"/>
            : <Icon.chevronRight width="14" height="14" className="text-[#6e7681]"/>}
        </div>
      </div>
      <div className="text-[11px] text-[#8b949e] tabular-nums">
        {typeof store.myDoneCount === "number" && store.myDoneCount > 0
          ? `${store.myDoneCount} of ${store.itemCount} done`
          : `${store.itemCount} item${store.itemCount === 1 ? "" : "s"}`}
      </div>
    </button>
  );
}

// Brand-card grid for the assist view. Mirrors the admin Stores layout
// but stripped down: no Add-store tile, no job activity badges — just
// brand name, last-imported date, and the count of imported items.

function AssistStores({ stores, loading, onOpenStore }) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1200px] mx-auto px-8 py-8">
        <div className="flex items-baseline justify-between mb-6">
          <div>
            <h1 className="font-serif text-[40px] leading-[1] tracking-tight text-[#e6edf3]">Brands</h1>
            <p className="text-[12px] text-[#8b949e] mt-2">
              {loading
                ? "Loading…"
                : stores.length === 0
                  ? "Nothing imported yet."
                  : `${stores.length} brand${stores.length === 1 ? "" : "s"}`}
            </p>
          </div>
        </div>

        {stores.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {stores.map(store => (
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

function AssistStoreCard({ store, onClick }) {
  return (
    <button
      onClick={onClick}
      className="text-left border rounded-[6px] p-4 transition-colors bg-[#0d1117] border-[#21262d] hover:border-[#30363d]"
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
          <Icon.chevronRight width="14" height="14" className="text-[#6e7681]"/>
        </div>
      </div>
      <div className="text-[11px] text-[#8b949e]">
        {store.itemCount} item{store.itemCount === 1 ? "" : "s"}
      </div>
    </button>
  );
}

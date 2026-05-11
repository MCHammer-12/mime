// Brand-card grid for the assist view. Search + Mine/All filter at the
// top; cards gray out when the requesting assistant (?as=) has checked
// off every item for that brand. Drag-and-drop reorders the cards per
// assistant — the new ordering persists server-side via the card_priority
// table.

const { useState: useSAS, useMemo: useMAS, useRef: useRAS } = React;

function AssistStores({ stores, loading, author, preview, onOpenStore, onReorder }) {
  const [query, setQuery] = useSAS("");
  // Default to "mine" when an assistant is signed in viewing their own work.
  // In preview mode (admin checking what Dennis/Toby see) default to "all"
  // — Michael isn't an assistant, so Mine would only show brands the
  // previewed assistant has already engaged, which is rarely what's
  // useful when previewing.
  const [scope, setScope] = useSAS(author && !preview ? "mine" : "all");
  const [dragIndex, setDragIndex] = useSAS(null);

  // Filtering is independent of ordering — ordering applies to the full
  // stores array (managed by the parent). Filter only affects what's
  // displayed. So drag reorders against the underlying full array.
  const filtered = useMAS(() => {
    const q = query.trim().toLowerCase();
    return stores.filter(s => {
      if (scope === "mine" && !s.myEngaged && !s.mineComplete) return false;
      if (q && !s.storeName.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [stores, query, scope]);

  // Drag-reorder is only useful when the user can see every card. When a
  // search is active or scope=mine hides some cards, the visible-vs-full
  // mapping gets confusing — disable drag in that state and tell them why.
  const draggable = Boolean(author && !preview && query.trim() === "" && scope === "all");

  const totalLabel = loading
    ? "Loading…"
    : stores.length === 0
      ? "Nothing imported yet."
      : `${filtered.length} of ${stores.length} brand${stores.length === 1 ? "" : "s"}`;

  const onDragStart = (idx) => {
    setDragIndex(idx);
  };
  const onDragEnter = (targetIdx) => {
    // Reorder live as the user drags over other cards. The visible order
    // is the new order; we splice the underlying stores array and ask
    // the parent to re-render with the new sequence.
    if (dragIndex === null || dragIndex === targetIdx) return;
    const next = [...stores];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(targetIdx, 0, moved);
    setDragIndex(targetIdx);
    onReorder(next.map(s => s.storeId), { preview: true });
  };
  const onDragEnd = () => {
    if (dragIndex !== null && onReorder) {
      // Final commit — POST the saved order to the server.
      onReorder(stores.map(s => s.storeId), { preview: false });
    }
    setDragIndex(null);
  };

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

        {author && !preview && !draggable && stores.length > 1 && (
          <p className="text-[10px] text-[#6e7681] mb-3">
            Clear the search + switch to All to drag-reorder cards.
          </p>
        )}

        {filtered.length === 0 && stores.length > 0 && !loading && (
          <div className="text-[12px] text-[#6e7681] py-8 text-center border border-dashed border-[#30363d] rounded-[6px]">
            No brands match.
          </div>
        )}

        {filtered.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {filtered.map(store => {
              // Look up the dragged card's index in the underlying ordered
              // stores array, not the filtered list, so drag works against
              // the persisted order.
              const fullIdx = stores.indexOf(store);
              return (
                <AssistStoreCard
                  key={store.storeId}
                  store={store}
                  draggable={draggable}
                  isDragging={draggable && dragIndex === fullIdx}
                  onClick={() => onOpenStore(store.storeId)}
                  onDragStart={() => onDragStart(fullIdx)}
                  onDragEnter={() => onDragEnter(fullIdx)}
                  onDragEnd={onDragEnd}
                />
              );
            })}
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

function AssistStoreCard({ store, draggable, isDragging, onClick, onDragStart, onDragEnter, onDragEnd }) {
  const dim = store.mineComplete;
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onDragOver={(e) => { if (draggable) e.preventDefault(); }}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className={
        "text-left border rounded-[6px] p-4 transition-all bg-[#0d1117] " +
        (draggable ? "cursor-grab active:cursor-grabbing " : "cursor-pointer ") +
        (isDragging ? "opacity-30 border-[#388bfd] " : "") +
        (dim
          ? "border-[#21262d] hover:border-[#30363d] opacity-50"
          : "border-[#21262d] hover:border-[#30363d]")
      }
      title={dim ? "All items checked off" : (draggable ? "Drag to reorder" : undefined)}
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0 flex items-start gap-2">
          {draggable && (
            <span className="text-[#484f58] mt-1 leading-none" aria-hidden="true">⋮⋮</span>
          )}
          <div>
            <div className="font-serif text-[22px] leading-[1.1] text-[#e6edf3] truncate">
              {store.storeName}
            </div>
            <div className="text-[11px] text-[#6e7681] mt-1">
              Last imported {relDate(store.lastImportedAt)} ago
            </div>
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
    </div>
  );
}

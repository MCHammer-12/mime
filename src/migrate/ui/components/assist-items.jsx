// Per-store items list. Single scrollable list, no tabs — emails and
// flows mixed, sorted by recently imported. Each row: type tag, name,
// note textarea (save-on-blur). Failed items don't appear (server filter).

const { useState: useStateAI, useEffect: useEffectAI, useRef: useRefAI } = React;

function AssistItems({ store, items, loading, author, onSaveNote, onBack }) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[900px] mx-auto px-8 py-8">
        <button
          onClick={onBack}
          className="text-[11px] text-[#8b949e] hover:text-[#e6edf3] mb-4 inline-flex items-center gap-1"
        >
          <Icon.chevronRight width="12" height="12" className="rotate-180"/>
          Brands
        </button>
        <div className="flex items-baseline justify-between mb-6">
          <h1 className="font-serif text-[40px] leading-[1] tracking-tight text-[#e6edf3]">
            {store ? store.storeName : "…"}
          </h1>
          <div className="text-[11px] text-[#8b949e]">
            {loading ? "Loading…" : `${items.length} item${items.length === 1 ? "" : "s"}`}
          </div>
        </div>

        {items.length === 0 && !loading && (
          <div className="text-[12px] text-[#6e7681] py-8 text-center border border-dashed border-[#30363d] rounded-[6px]">
            No imported items for this brand yet.
          </div>
        )}

        <div className="space-y-2">
          {items.map(item => (
            <AssistItemRow
              key={item.itemId}
              item={item}
              author={author}
              onSaveNote={onSaveNote}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function AssistItemRow({ item, author, onSaveNote }) {
  const [text, setText] = useStateAI(item.note ? item.note.text : "");
  const [savedAt, setSavedAt] = useStateAI(item.note ? item.note.savedAt : null);
  const [savedBy, setSavedBy] = useStateAI(item.note ? item.note.author : null);
  const [saving, setSaving] = useStateAI(false);
  // Track whether the local buffer has been edited since the last server
  // confirmation — used to decide whether to flush on blur.
  const dirtyRef = useRefAI(false);

  const flushNow = async () => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    setSaving(true);
    try {
      const result = await onSaveNote(item.itemId, text);
      if (result && result.note) {
        setSavedAt(result.note.savedAt);
        setSavedBy(result.note.author);
      } else {
        setSavedAt(null);
        setSavedBy(null);
      }
    } finally {
      setSaving(false);
    }
  };

  const onChange = (e) => {
    dirtyRef.current = true;
    setText(e.target.value);
  };

  return (
    <div className="border border-[#21262d] hover:border-[#30363d] rounded-[6px] p-4 bg-[#0d1117] transition-colors">
      <div className="flex items-baseline gap-3 mb-2">
        <span className="text-[10px] uppercase tracking-wider text-[#484f58] w-[40px] flex-shrink-0">
          {item.itemType === "flow" ? "flow" : "email"}
        </span>
        <span className="text-[14px] text-[#e6edf3] truncate flex-1 min-w-0">
          {item.name}
        </span>
        <span className="text-[11px] text-[#6e7681] tabular-nums flex-shrink-0">
          imported {relDate(item.importedAt)} ago
        </span>
      </div>
      <textarea
        value={text}
        onChange={onChange}
        onBlur={flushNow}
        placeholder="Add a note… (saves when you click away)"
        rows={2}
        className="w-full bg-[#010409] border border-[#21262d] focus:border-[#388bfd] outline-none rounded-[4px] px-3 py-2 text-[12px] text-[#e6edf3] placeholder:text-[#484f58] resize-y"
      />
      <div className="text-[10px] text-[#6e7681] mt-1 h-3">
        {saving
          ? "Saving…"
          : savedAt
            ? `Saved${savedBy ? ` by ${savedBy}` : ""}${savedAt ? ` · ${relDate(savedAt)} ago` : ""}`
            : ""}
      </div>
    </div>
  );
}

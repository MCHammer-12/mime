// Per-store items list. Single scrollable list, no tabs — emails and
// flows mixed, sorted by recently imported. Each row: checkbox, type
// tag, name, note textarea. Checkbox toggles per-assistant "done"
// state; the brand card on the picker grays out when all rows in a
// store are done by the requesting assistant. Failed items don't appear
// (server filter).

const { useState: useStateAI, useEffect: useEffectAI, useRef: useRefAI } = React;

function AssistItems({ store, items, loading, author, onSaveNote, onToggleDone, onBack }) {
  const doneCount = items.filter(i => i.done).length;
  const counterLabel = loading
    ? "Loading…"
    : items.length === 0
      ? "0 items"
      : author
        ? `${doneCount} of ${items.length} done`
        : `${items.length} item${items.length === 1 ? "" : "s"}`;

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
          <div className="text-[11px] text-[#8b949e] tabular-nums">{counterLabel}</div>
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
              onToggleDone={onToggleDone}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function AssistItemRow({ item, author, onSaveNote, onToggleDone }) {
  const [text, setText] = useStateAI(item.note ? item.note.text : "");
  const [savedAt, setSavedAt] = useStateAI(item.note ? item.note.savedAt : null);
  const [savedBy, setSavedBy] = useStateAI(item.note ? item.note.author : null);
  const [saving, setSaving] = useStateAI(false);
  // Local mirror of the per-assistant "done" state — flipped optimistically
  // on click, reverted if the POST fails so the UI stays honest.
  const [done, setDone] = useStateAI(Boolean(item.done));
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

  const toggleDone = async () => {
    if (!author) return; // Can't mark done without an identity
    const next = !done;
    setDone(next);
    const ok = await onToggleDone(item.itemId, next);
    if (!ok) setDone(!next); // revert on failure
  };

  return (
    <div
      className={
        "border rounded-[6px] p-4 bg-[#0d1117] transition-colors " +
        (done
          ? "border-[#21262d] opacity-50"
          : "border-[#21262d] hover:border-[#30363d]")
      }
    >
      <div className="flex items-center gap-3 mb-2">
        <button
          onClick={toggleDone}
          disabled={!author}
          title={author ? (done ? "Mark not done" : "Mark done") : "Open with ?as=<your name> to check off"}
          className={
            "w-[16px] h-[16px] rounded-[3px] border flex items-center justify-center flex-shrink-0 transition-colors " +
            (done
              ? "bg-[#238636] border-[#2ea043]"
              : "bg-[#010409] border-[#30363d] hover:border-[#6e7681]") +
            (!author ? " opacity-40 cursor-not-allowed" : " cursor-pointer")
          }
        >
          {done && (
            <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3.5 8.2L6.5 11.3L12.5 4.7"/>
            </svg>
          )}
        </button>
        <span className="text-[10px] uppercase tracking-wider text-[#484f58] w-[40px] flex-shrink-0">
          {item.itemType === "flow" ? "flow" : "email"}
        </span>
        <span
          className={
            "text-[14px] truncate flex-1 min-w-0 " +
            (done ? "text-[#8b949e] line-through" : "text-[#e6edf3]")
          }
        >
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

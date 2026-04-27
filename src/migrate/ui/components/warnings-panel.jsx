// Warnings side panel — slide-in from right. Scoped to a single item.
// Supports prev/next navigation across all warning-bearing items in a job.

const { useState: useWP, useMemo: useWPM, useEffect: useWPE } = React;

function WarningsPanel({ job, startItemId, onClose }) {
  const flaggedItems = useWPM(
    () => (job?.items || []).filter(i => (i.itemWarnings || []).length > 0),
    [job]
  );
  const initialIdx = Math.max(0, flaggedItems.findIndex(i => i.id === startItemId));
  const [idx, setIdx] = useWP(initialIdx);
  const [reviewed, setReviewed] = useWP(new Set());

  useWPE(() => { setIdx(Math.max(0, flaggedItems.findIndex(i => i.id === startItemId))); }, [startItemId, job?.id]);

  if (!job) return null;

  // Job-level warnings (no item id) — shown on every view, and used as
  // the sole content when there are no item-flagged rows but the importer
  // emitted broader notices (e.g. "review export in Klaviyo dashboard").
  const jobWarnings = (job.warnings || []).map(t => ({ text: t, category: classifyWarning(t) }));
  const jobGrouped = {};
  jobWarnings.forEach(w => { (jobGrouped[w.category] ||= []).push(w); });

  // Truly nothing to show.
  if (flaggedItems.length === 0 && jobWarnings.length === 0) {
    return (
      <Shell onClose={onClose} title="No warnings" subtitle={`Job ${job.shortId}`}>
        <div className="px-5 py-6 text-[12px] text-[#6e7681]">Nothing to review on this job.</div>
      </Shell>
    );
  }

  // Job-level-only mode: render a simpler shell with no per-item nav and
  // no "mark reviewed" footer (there's no item to mark).
  if (flaggedItems.length === 0) {
    return (
      <Shell
        onClose={onClose}
        title="Job warnings"
        subtitle={
          <span className="inline-flex items-center gap-2">
            <span>Job {job.shortId}</span>
            <span>·</span>
            <span>{jobWarnings.length} warning{jobWarnings.length === 1 ? "" : "s"}</span>
          </span>
        }
      >
        <div className="flex-1 overflow-y-auto">
          {Object.keys(jobGrouped).map(cat => (
            <Category key={"jl_"+cat} label={cat} items={jobGrouped[cat]}/>
          ))}
        </div>
      </Shell>
    );
  }

  const item = flaggedItems[idx] || flaggedItems[0];
  const grouped = {};
  (item.itemWarnings || []).forEach(w => {
    (grouped[w.category] ||= []).push(w);
  });
  const categories = Object.keys(grouped);
  const isReviewed = reviewed.has(item.id);

  return (
    <Shell
      onClose={onClose}
      title={item.name}
      subtitle={
        <span className="inline-flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-[#6e7681]">{item.kind}</span>
          <span>·</span>
          <span>{(item.itemWarnings || []).length} warning{(item.itemWarnings || []).length === 1 ? "" : "s"}</span>
          {isReviewed && <span className="text-[#3fb950] text-[10px]">· reviewed</span>}
        </span>
      }
      header={
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIdx(i => Math.max(0, i - 1))}
            disabled={idx === 0}
            className="px-1.5 py-0.5 text-[#8b949e] hover:text-[#e6edf3] disabled:opacity-30 disabled:pointer-events-none"
            title="Previous flagged item"
          >
            <Icon.chevronRight width="12" height="12" style={{ transform: "rotate(180deg)" }}/>
          </button>
          <span className="text-[11px] text-[#6e7681] tabular-nums">
            {idx + 1} / {flaggedItems.length}
          </span>
          <button
            onClick={() => setIdx(i => Math.min(flaggedItems.length - 1, i + 1))}
            disabled={idx === flaggedItems.length - 1}
            className="px-1.5 py-0.5 text-[#8b949e] hover:text-[#e6edf3] disabled:opacity-30 disabled:pointer-events-none"
            title="Next flagged item"
          >
            <Icon.chevronRight width="12" height="12"/>
          </button>
        </div>
      }
    >
      <div className="flex-1 overflow-y-auto">
        {categories.map(cat => (
          <Category key={cat} label={cat} items={grouped[cat]}/>
        ))}
        {Object.keys(jobGrouped).length > 0 && (
          <>
            <div className="px-5 pt-4 pb-1 text-[10px] uppercase tracking-wider text-[#6e7681] border-t border-[#21262d] mt-3">
              Job-level warnings
            </div>
            {Object.keys(jobGrouped).map(cat => (
              <Category key={"jl_"+cat} label={cat} items={jobGrouped[cat]}/>
            ))}
          </>
        )}
      </div>

      <div className="px-5 py-3 border-t border-[#21262d] bg-[#010409] flex items-center gap-2">
        <button
          onClick={() => setReviewed(s => { const n = new Set(s); isReviewed ? n.delete(item.id) : n.add(item.id); return n; })}
          className={
            "text-[11px] px-2.5 py-1 rounded-[3px] border " +
            (isReviewed
              ? "border-[#3fb95040] text-[#3fb950] bg-[#3fb95018]"
              : "border-[#30363d] text-[#e6edf3] hover:bg-[#21262d]")
          }
        >
          {isReviewed ? "✓ Reviewed" : "Mark reviewed"}
        </button>
        <span className="text-[10px] text-[#6e7681] ml-auto">
          Local-only. Collapses the chip on this row.
        </span>
      </div>
    </Shell>
  );
}

function Category({ label, items }) {
  const [open, setOpen] = useWP(true);
  return (
    <div className="border-b border-[#21262d] last:border-b-0">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-5 py-2.5 hover:bg-[#21262d60]"
      >
        {open ? <Icon.chevronDown width="11" height="11" className="text-[#6e7681]"/>
              : <Icon.chevronRight width="11" height="11" className="text-[#6e7681]"/>}
        <span className="text-[11px] uppercase tracking-wider text-[#e6edf3]">{label}</span>
        <span className="text-[10px] text-[#6e7681] tabular-nums">· {items.length}</span>
      </button>
      {open && (
        <div className="px-5 pb-3 space-y-1.5">
          {items.map((w, i) => (
            <div key={i} className="text-[11px] text-[#c9d1d9] bg-[#d2992215] border-l-2 border-[#d29922] px-2.5 py-1.5 font-mono leading-relaxed">
              {w.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Shell({ title, subtitle, header, onClose, children }) {
  return (
    <>
      <div className="fixed inset-0 z-40 bg-[#01040988]" onClick={onClose}/>
      <div className="fixed right-0 top-0 bottom-0 z-50 w-[440px] bg-[#0d1117] border-l border-[#30363d] flex flex-col shadow-2xl">
        <div className="px-5 py-3 border-b border-[#21262d] flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-[#d29922] mb-1">
              <Icon.alert width="10" height="10"/>
              Warnings
            </div>
            <div className="font-serif text-[20px] leading-[1.1] text-[#e6edf3] truncate">{title}</div>
            <div className="text-[11px] text-[#8b949e] mt-0.5">{subtitle}</div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <button onClick={onClose} className="text-[#6e7681] hover:text-[#e6edf3]">
              <Icon.x width="14" height="14"/>
            </button>
            {header}
          </div>
        </div>
        {children}
      </div>
    </>
  );
}

window.WarningsPanel = WarningsPanel;

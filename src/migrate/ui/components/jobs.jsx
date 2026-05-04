// Jobs panel — runs as a sticky right drawer.
//
// TRADE-OFF DECISIONS (baked in here, ready to push back on):
//
// 1. Progress display: per-item stacked rows, grouped by state
//    (running → failed → done, collapsed). A scrolling log loses structure
//    at 30 items; a pure collapsed summary hides failures; stacked rows
//    with state-based grouping scans cleanly in <3s even at 50 items.
//
// 2. Jobs panel placement: sticky right drawer, 400px.
//    - Full column steals lateral space from the browse list (which IS the
//      work surface 80% of the time).
//    - Bottom dock hides items off-screen under 1440p laptops.
//    - Right drawer lets both lists and running work stay visible
//      simultaneously — the "start a second batch while first runs" path.
//    Collapsible to a 40px rail so power users can reclaim width.
//
// 3. Selection counter + Import button: fixed header (not floating).
//    A floating FAB is marketing energy; a fixed row between tabs and list
//    is where ops eyes already are. Disappears when zero selected.
//
// 4. "Already imported" knowledge: per-row "imported earlier" text tag
//    (muted) + opt-in "Hide already imported" filter in the list toolbar.
//    A badge on the row, not a separate column, so at-a-glance scan still
//    works. (In the real app this data comes from Redo's /templates lookup.)

const { useState: useStateJobs, useEffect: useEffectJobs, useRef: useRefJobs } = React;

function JobsPanel({ jobs, onRetryItem, onDismissJob, onCancelJob, collapsed, onToggleCollapsed, onOpenLog, onOpenWarnings, onSaveNote, onExportBundle, scopeLabel }) {
  const activeCount = jobs.filter(j => j.status === "running").length;
  const failedCount = jobs.reduce((s, j) => s + j.items.filter(i => i.state === "failed").length, 0);
  const waitingCount = jobs.filter(j => j.status === "waiting_input").length;

  if (collapsed) {
    return (
      <div className="w-[40px] border-l border-[#21262d] bg-[#010409] flex flex-col items-center py-3 gap-3">
        <button
          onClick={onToggleCollapsed}
          className="text-[#8b949e] hover:text-[#e6edf3]"
          title="Expand jobs panel"
        >
          <Icon.chevronRight width="16" height="16" className="rotate-180"/>
        </button>
        <div className="w-px h-3 bg-[#21262d]"/>
        <div className="text-[10px] uppercase tracking-wider text-[#6e7681] [writing-mode:vertical-rl] rotate-180 mt-2">
          Jobs {jobs.length > 0 && `· ${jobs.length}`}
        </div>
        {activeCount > 0 && (
          <div className="mt-auto mb-2 w-2 h-2 rounded-full bg-[#388bfd] animate-pulse"/>
        )}
        {waitingCount > 0 && <div className="w-2 h-2 rounded-full bg-[#58a6ff]"/>}
        {failedCount > 0 && (
          <div className="w-2 h-2 rounded-full bg-[#f85149]"/>
        )}
      </div>
    );
  }

  return (
    <div className="w-[400px] border-l border-[#21262d] bg-[#010409] flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#21262d]">
        <div className="flex flex-col">
          <span className="text-[11px] uppercase tracking-wider text-[#e6edf3]">Jobs</span>
          {scopeLabel && <span className="text-[10px] text-[#6e7681]">scope: {scopeLabel}</span>}
        </div>
        <span className="text-[11px] text-[#6e7681] tabular-nums ml-2">
          {jobs.length} total
          {activeCount > 0 && <span className="text-[#388bfd]"> · {activeCount} running</span>}
          {waitingCount > 0 && <span className="text-[#58a6ff]"> · {waitingCount} waiting</span>}
          {failedCount > 0 && <span className="text-[#f85149]"> · {failedCount} failed</span>}
        </span>
        <button
          onClick={onToggleCollapsed}
          className="ml-auto text-[#6e7681] hover:text-[#e6edf3]"
          title="Collapse"
        >
          <Icon.chevronRight width="14" height="14"/>
        </button>
      </div>

      {jobs.length === 0 ? (
        <div className="flex-1 flex items-center justify-center px-8 text-center">
          <div className="text-[11px] text-[#484f58] leading-relaxed">
            No jobs yet. Select flows or templates and hit Import.<br/>
            Jobs run concurrently — start a second batch anytime.
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {jobs.map(job => (
            <JobCard
              key={job.id}
              job={job}
              onRetryItem={onRetryItem}
              onDismissJob={onDismissJob}
              onCancelJob={onCancelJob}
              onOpenLog={onOpenLog}
              onOpenWarnings={onOpenWarnings}
              onSaveNote={onSaveNote}
              onExportBundle={onExportBundle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function JobCard({ job, onRetryItem, onDismissJob, onCancelJob, onOpenLog, onOpenWarnings, onSaveNote, onExportBundle }) {
  const running = job.items.filter(i => i.state === "running" || i.state === "queued");
  const failed  = job.items.filter(i => i.state === "failed");
  const done    = job.items.filter(i => i.state === "imported");
  const flaggedCount = job.items.filter(i => (i.itemWarnings || []).length > 0).length;
  const firstFlaggedId = (job.items.find(i => (i.itemWarnings || []).length > 0) || {}).id;
  const jobWarningCount = (job.warnings || []).length;
  // Total surfaces of "needs your attention" — item warnings + job-level
  // warnings. Used to gate the Review banner so users can always reach the
  // warnings panel when *any* warning has been emitted, not just when an
  // item carries one.
  const totalWarningSources = flaggedCount + jobWarningCount;

  const [doneExpanded, setDoneExpanded] = useStateJobs(false);

  const total = job.items.length;
  const pctDone = total ? Math.round(((done.length + failed.length) / total) * 100) : 0;

  const stateColor = {
    running:       "#388bfd",
    waiting_input: "#58a6ff",
    complete:      "#3fb950",
    partial:       "#d29922",
    canceled:      "#6e7681",
  }[job.status] || "#6e7681";

  const elapsed = useElapsed(job.startedAt, job.endedAt);

  return (
    <div className="border-b border-[#21262d] py-3">
      {/* Job header */}
      <div className="px-4 pb-2 flex items-center gap-2">
        <span
          className={"w-2 h-2 rounded-full " + (job.status === "running" || job.status === "waiting_input" ? "animate-pulse" : "")}
          style={{ background: stateColor }}
        />
        <div className="flex flex-col min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="font-serif text-[15px] leading-none text-[#e6edf3] tabular-nums">{job.storeName || "Job"}</span>
            <span className="text-[11px] text-[#6e7681] tabular-nums">· Job {job.shortId}</span>
          </div>
          <span className="text-[10px] text-[#6e7681] truncate mt-0.5">
            {job.templateCount + job.flowCount} items
            {job.flowCount > 0 && ` · ${job.flowCount} flow${job.flowCount === 1 ? "" : "s"}`}
            {job.templateCount > 0 && ` · ${job.templateCount} template${job.templateCount === 1 ? "" : "s"}`}
          </span>
        </div>
        <span className="ml-auto text-[10px] text-[#6e7681] tabular-nums">{elapsed}</span>
        {job.status === "running" || job.status === "waiting_input" ? (
          <button
            onClick={() => onCancelJob(job.id)}
            className="text-[10px] text-[#8b949e] hover:text-[#f85149] px-1.5 py-0.5 border border-[#30363d] rounded-[3px]"
            title="Cancel remaining items"
          >
            <Icon.stop width="8" height="8"/>
          </button>
        ) : (
          <button
            onClick={() => onDismissJob(job.id)}
            className="text-[#6e7681] hover:text-[#e6edf3]"
            title="Dismiss job"
          >
            <Icon.x width="12" height="12"/>
          </button>
        )}
      </div>

      {job.status === "waiting_input" && (
        <div className="mx-4 mb-2 px-2 py-1.5 text-[11px] text-[#58a6ff] bg-[#58a6ff15] border border-[#58a6ff40] rounded-[3px] flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-[#58a6ff]"/>
          paused — needs your input
        </div>
      )}

      {/* Progress bar */}
      <div className="px-4 mb-2">
        <div className="h-[3px] bg-[#21262d] rounded-full overflow-hidden flex">
          <div
            className="h-full transition-all duration-300"
            style={{ width: `${(done.length / total) * 100}%`, background: "#238636" }}
          />
          <div
            className="h-full transition-all duration-300"
            style={{ width: `${(failed.length / total) * 100}%`, background: "#f85149" }}
          />
        </div>
        <div className="flex items-center justify-between mt-1 text-[10px] text-[#6e7681] tabular-nums">
          <span>
            {job.status === "running"
              ? (job.currentStep || "starting…")
              : <>
                  {done.length} imported
                  {failed.length > 0 && <span className="text-[#f85149]"> · {failed.length} failed</span>}
                </>
            }
          </span>
          <span>{pctDone}%</span>
        </div>
      </div>

      {/* Running items */}
      {running.length > 0 && (
        <ItemGroup label="In flight" items={running} tone="running" onOpenWarnings={onOpenWarnings && ((id) => onOpenWarnings(job.id, id))}/>
      )}

      {/* Waiting input items */}
      {job.items.filter(i => i.state === "waiting_input").length > 0 && (
        <ItemGroup label="Needs input" items={job.items.filter(i => i.state === "waiting_input")} tone="waiting_input" onOpenWarnings={onOpenWarnings && ((id) => onOpenWarnings(job.id, id))}/>
      )}

      {/* Failed items */}
      {failed.length > 0 && (
        <ItemGroup
          label="Failed"
          items={failed}
          tone="failed"
          onRetryItem={(item) => onRetryItem(job.id, item)}
          onOpenWarnings={onOpenWarnings && ((id) => onOpenWarnings(job.id, id))}
        />
      )}

      {/* Done items — collapsed by default */}
      {done.length > 0 && (
        <div className="px-4 mt-1">
          <button
            onClick={() => setDoneExpanded(!doneExpanded)}
            className="w-full flex items-center gap-1.5 py-1 text-[10px] uppercase tracking-wider text-[#6e7681] hover:text-[#e6edf3]"
          >
            {doneExpanded
              ? <Icon.chevronDown width="10" height="10"/>
              : <Icon.chevronRight width="10" height="10"/>}
            Imported · {done.length}
          </button>
          {doneExpanded && (
            <div className="space-y-0.5 pb-1">
              {done.map(item => (
                <ItemRow key={item.id} item={item} tone="done" onOpenWarnings={onOpenWarnings && ((id) => onOpenWarnings(job.id, id))}/>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Fatal error */}
      {job.fatalError && (
        <div className="px-4 mt-2 text-[11px] text-[#f85149] bg-[#f8514918] border border-[#f8514940] rounded-[3px] py-1.5 px-2 mx-4 flex items-start gap-1.5">
          <Icon.alert width="11" height="11" className="mt-0.5 flex-shrink-0"/>
          <span className="font-mono">{job.fatalError}</span>
        </div>
      )}

      {/* Export summary + fonts — only visible when export phase finished */}
      {(job.exportSummary || job.fontsDone) && (
        <div className="px-4 mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-[#6e7681]">
          {job.exportSummary && (
            <span>
              export <span className="text-[#e6edf3] tabular-nums">{job.exportSummary.exported}</span>
              {job.exportSummary.failed > 0 && <span className="text-[#f85149]"> · {job.exportSummary.failed} failed</span>}
            </span>
          )}
          {job.fontsDone && (
            <span>
              fonts <span className="text-[#e6edf3] tabular-nums">{job.fontsDone.uploaded}↑</span>
              {" · "}<span className="text-[#e6edf3] tabular-nums">{job.fontsDone.registeredFamilies}</span> fam
              {job.fontsDone.unresolved && job.fontsDone.unresolved.length > 0 && (
                <span className="text-[#d29922]"> · {job.fontsDone.unresolved.length} unresolved</span>
              )}
            </span>
          )}
          {job.importMethod && (
            <span>via <span className="text-[#e6edf3]">{job.importMethod}</span></span>
          )}
        </div>
      )}

      {/* Warnings summary banner — always reachable. Covers item-level
          warnings (per-item issues like skipped steps), job-level warnings
          (broader notices the importer emits without an item id), or both.
          Visible during running jobs too so users can peek at warnings as
          they accumulate. Clicking opens the slide-in WarningsPanel; if
          there are no item-flagged rows we still pass undefined and the
          panel will surface the job-level warnings on its first view. */}
      {totalWarningSources > 0 && (
        <div className="mx-4 mt-2 px-2.5 py-1.5 bg-[#d2992215] border border-[#d2992240] rounded-[3px] flex items-center gap-2">
          {(job.status === "complete" || job.status === "partial") && (
            <>
              <Icon.check width="11" height="11" className="text-[#3fb950] flex-shrink-0"/>
              <span className="text-[11px] text-[#c9d1d9]">
                <span className="tabular-nums">{done.length}</span> imported.
              </span>
            </>
          )}
          <Icon.alert width="11" height="11" className="text-[#d29922] flex-shrink-0 ml-1"/>
          <span className="text-[11px] text-[#d29922]">
            <span className="tabular-nums">{totalWarningSources}</span>
            {" "}need{totalWarningSources === 1 ? "s" : ""} your attention
          </span>
          <button
            onClick={() => onOpenWarnings && onOpenWarnings(job.id, firstFlaggedId)}
            className="ml-auto text-[11px] text-[#58a6ff] hover:text-[#79c0ff] font-medium"
          >
            Review →
          </button>
        </div>
      )}

      <div className="px-4 mt-2 flex gap-2 text-[10px]">
        <button
          onClick={() => onOpenLog(job.id)}
          className="text-[#8b949e] hover:text-[#e6edf3]"
        >
          raw log →
        </button>
      </div>

      {/* Troubleshoot panel — only after a job is in a terminal state. Lets
          the user pick problematic templates/flows, attach a note about
          what's wrong, and download a zip Claude can read directly. */}
      {(job.status === "complete" || job.status === "partial" || job.status === "canceled" || job.fatalError) && (
        <TroubleshootPanel
          job={job}
          onSaveNote={onSaveNote}
          onExportBundle={onExportBundle}
        />
      )}
    </div>
  );
}

function TroubleshootPanel({ job, onSaveNote, onExportBundle }) {
  // Default-expanded so successfully-imported items are immediately visible
  // for feedback. Failed items already get attention via the inline error
  // display; the panel's main job is to capture notes on imports that
  // technically succeeded but look wrong in Redo.
  const [open, setOpen] = useStateJobs(true);
  const [selected, setSelected] = useStateJobs(() => new Set());
  // Local note buffers so typing doesn't lag while we debounce-save.
  const [localNotes, setLocalNotes] = useStateJobs(() => ({ ...(job.notes || {}) }));
  const [exporting, setExporting] = useStateJobs(false);
  const saveTimers = useRefJobs({});

  // Items that are interesting to troubleshoot — anything that finished
  // (imported or failed). Queued/running items aren't ready to debug.
  const items = job.items.filter(i => i.state === "imported" || i.state === "failed");
  if (items.length === 0) return null;

  const toggleSelected = (id) => {
    setSelected(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const selectAll = () => setSelected(new Set(items.map(i => i.id)));
  const clearAll = () => setSelected(new Set());

  const updateNote = (itemId, text) => {
    setLocalNotes(n => ({ ...n, [itemId]: text }));
    // Debounce save: wait 500ms after the last keystroke before POSTing.
    if (saveTimers.current[itemId]) clearTimeout(saveTimers.current[itemId]);
    saveTimers.current[itemId] = setTimeout(() => {
      onSaveNote && onSaveNote(job.id, itemId, text);
    }, 500);
  };

  const flushAndExport = async () => {
    if (selected.size === 0) return;
    // Flush any pending note saves before bundling so the zip includes them.
    for (const [itemId, t] of Object.entries(saveTimers.current)) {
      if (t) {
        clearTimeout(t);
        await Promise.resolve(onSaveNote && onSaveNote(job.id, itemId, localNotes[itemId] ?? ""));
      }
    }
    saveTimers.current = {};
    setExporting(true);
    try {
      const items = [...selected].map(id => {
        const it = job.items.find(x => x.id === id);
        return { id, type: (it && it.kind === "flow") ? "flow" : "template" };
      });
      await onExportBundle(job.id, items);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="mx-4 mt-3 border-t border-[#21262d] pt-2">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 py-1 text-[10px] uppercase tracking-wider text-[#6e7681] hover:text-[#e6edf3]"
      >
        {open
          ? <Icon.chevronDown width="10" height="10"/>
          : <Icon.chevronRight width="10" height="10"/>}
        Add feedback · any item ({items.length})
        {Object.values(localNotes).filter(n => (n||"").trim()).length > 0 && (
          <span className="ml-auto text-[10px] text-[#58a6ff] normal-case tracking-normal">
            {Object.values(localNotes).filter(n => (n||"").trim()).length} noted
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-2 pb-2">
          <div className="flex items-center gap-2 text-[10px] text-[#8b949e]">
            <button onClick={selectAll} className="hover:text-[#e6edf3]">select all</button>
            <span className="text-[#30363d]">·</span>
            <button onClick={clearAll} className="hover:text-[#e6edf3]">clear</button>
            <span className="ml-auto tabular-nums">
              {selected.size} selected
            </span>
            <button
              onClick={flushAndExport}
              disabled={selected.size === 0 || exporting}
              className="ml-2 px-2 py-1 text-[11px] text-[#e6edf3] bg-[#238636] hover:bg-[#2ea043] disabled:bg-[#30363d] disabled:text-[#6e7681] rounded-[3px]"
            >
              {exporting ? "exporting…" : `Export zip${selected.size > 0 ? ` (${selected.size})` : ""}`}
            </button>
          </div>
          {items.map(item => {
            const noteVal = localNotes[item.id] ?? "";
            return (
              <div key={item.id} className="border border-[#21262d] rounded-[3px] p-2 bg-[#0d1117]">
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() => toggleSelected(item.id)}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 text-[11px]">
                      <span className="text-[10px] uppercase tracking-wider text-[#484f58] w-[40px]">
                        {item.kind === "flow" ? "flow" : "tmpl"}
                      </span>
                      <span className="truncate text-[#e6edf3]">{item.name}</span>
                      <span className="text-[10px] text-[#6e7681] tabular-nums ml-auto">{item.id}</span>
                    </div>
                    {item.state === "failed" && item.error && (
                      <div className="text-[10px] text-[#f85149] opacity-80 font-mono mt-0.5">
                        {item.error}
                      </div>
                    )}
                    <textarea
                      value={noteVal}
                      onChange={e => updateNote(item.id, e.target.value)}
                      placeholder="What's wrong with this one? (footer padding off, button in wrong column, …)"
                      rows={2}
                      className="w-full mt-1 bg-[#010409] border border-[#30363d] focus:border-[#388bfd] outline-none rounded-[3px] px-2 py-1 text-[11px] text-[#e6edf3] placeholder:text-[#484f58] resize-y"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ItemGroup({ label, items, tone, onRetryItem, onOpenWarnings }) {
  const toneColor = { running: "#388bfd", failed: "#f85149", done: "#3fb950", waiting_input: "#58a6ff" }[tone];
  return (
    <div className="px-4 mt-2">
      <div className="flex items-center gap-1.5 py-1 text-[10px] uppercase tracking-wider text-[#6e7681]">
        <span className="w-1 h-1 rounded-full" style={{ background: toneColor }}/>
        {label} · {items.length}
      </div>
      <div className="space-y-0.5">
        {items.map(item => (
          <ItemRow
            key={item.id}
            item={item}
            tone={tone}
            onRetry={onRetryItem ? () => onRetryItem(item) : undefined}
            onOpenWarnings={onOpenWarnings}
          />
        ))}
      </div>
    </div>
  );
}

function ItemRow({ item, tone, onRetry, onOpenWarnings }) {
  const icon = {
    running:       <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#388bfd] animate-pulse"/>,
    queued:        <span className="inline-block w-1.5 h-1.5 rounded-full border border-[#30363d]"/>,
    waiting_input: <span className="inline-block w-2.5 h-2.5 rounded-full bg-[#58a6ff] text-[9px] text-white flex items-center justify-center font-bold">?</span>,
    done:          <Icon.check width="11" height="11" className="text-[#3fb950]"/>,
    failed:        <Icon.alert width="11" height="11" className="text-[#f85149]"/>,
  };
  const displayIcon = item.state === "queued" ? icon.queued
    : item.state === "waiting_input" ? icon.waiting_input
    : icon[tone];

  return (
    <div className="group">
      <div className="flex items-center gap-2 py-0.5 text-[11px]">
        <span className="w-3 flex-shrink-0 flex justify-center">{displayIcon}</span>
        <span className="text-[10px] text-[#484f58] uppercase tracking-wider w-[40px] flex-shrink-0">
          {item.kind === "flow" ? "flow" : "tmpl"}
        </span>
        <span className={"truncate " + (tone === "done" ? "text-[#8b949e]" : "text-[#e6edf3]")}>
          {item.name}
        </span>
        {item.state === "imported" && item.detail && (
          <span className="text-[10px] text-[#6e7681] tabular-nums ml-auto flex-shrink-0">{item.detail}</span>
        )}
        {(item.itemWarnings || []).length > 0 && onOpenWarnings && (
          <button
            onClick={() => onOpenWarnings(item.id)}
            className="ml-1 flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-[#d29922] bg-[#d2992218] hover:bg-[#d2992230] border border-[#d2992240] rounded-[3px] flex-shrink-0"
            title={`${item.itemWarnings.length} warning${item.itemWarnings.length === 1 ? "" : "s"} — click to review`}
          >
            <Icon.alert width="9" height="9"/>
            <span className="tabular-nums">{item.itemWarnings.length}</span>
          </button>
        )}
        {item.state === "failed" && onRetry && (
          <button
            onClick={onRetry}
            disabled={item.retrying}
            className="ml-auto flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-[#388bfd] hover:bg-[#388bfd18] rounded-[3px] disabled:opacity-50"
          >
            <Icon.refresh width="10" height="10" className={item.retrying ? "animate-spin" : ""}/>
            {item.retrying ? "retrying" : "retry"}
          </button>
        )}
      </div>
      {item.state === "failed" && item.error && (
        <div className="ml-[calc(12px+40px+8px)] text-[10px] text-[#f85149] opacity-80 font-mono leading-relaxed pb-1">
          {item.error}
        </div>
      )}
    </div>
  );
}

function useElapsed(start, end) {
  const [, tick] = useStateJobs(0);
  useEffectJobs(() => {
    if (end) return;
    const t = setInterval(() => tick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, [end]);
  if (!start) return "";
  const ms = (end || Date.now()) - start;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

Object.assign(window, { JobsPanel });

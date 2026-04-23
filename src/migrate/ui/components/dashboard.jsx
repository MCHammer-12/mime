// Dashboard — grid of store cards. Shows at-a-glance job status across stores.

const { useState: useSD } = React;

function Dashboard({ stores, jobs, onOpenStore, onAddStore, onDeleteStore }) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1200px] mx-auto px-8 py-8">
        <div className="flex items-baseline justify-between mb-6">
          <div>
            <h1 className="font-serif text-[40px] leading-[1] tracking-tight text-[#e6edf3]">Stores</h1>
            <p className="text-[12px] text-[#8b949e] mt-2">
              {stores.length} connected · jobs keep running when you switch stores
            </p>
          </div>
          <GlobalJobStatus jobs={jobs} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          <AddStoreCard onClick={onAddStore} />
          {stores.map(store => {
            const storeJobs = jobs.filter(j => j.storeId === store.id);
            return (
              <StoreCard
                key={store.id}
                store={store}
                jobs={storeJobs}
                onClick={() => onOpenStore(store.id)}
                onDelete={onDeleteStore ? () => onDeleteStore(store.id) : null}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function GlobalJobStatus({ jobs }) {
  const running = jobs.filter(j => j.status === "running").length;
  const failed = jobs.reduce((s, j) => s + j.items.filter(i => i.state === "failed").length, 0);
  const needsInput = jobs.filter(j => j.status === "waiting_input").length;

  if (jobs.length === 0) {
    return <span className="text-[11px] text-[#6e7681]">no jobs</span>;
  }

  return (
    <div className="flex items-center gap-4 text-[11px]">
      {running > 0 && (
        <span className="flex items-center gap-1.5 text-[#388bfd]">
          <span className="w-1.5 h-1.5 rounded-full bg-[#388bfd] animate-pulse"/>
          {running} running
        </span>
      )}
      {needsInput > 0 && (
        <span className="flex items-center gap-1.5 text-[#58a6ff]">
          <span className="w-1.5 h-1.5 rounded-full bg-[#58a6ff]"/>
          {needsInput} needs input
        </span>
      )}
      {failed > 0 && (
        <span className="flex items-center gap-1.5 text-[#f85149]">
          <span className="w-1.5 h-1.5 rounded-full bg-[#f85149]"/>
          {failed} failed
        </span>
      )}
    </div>
  );
}

function StoreCard({ store, jobs, onClick, onDelete }) {
  const running = jobs.filter(j => j.status === "running").length;
  const completed = jobs.filter(j => j.status === "complete").length;
  const failed = jobs.filter(j => j.status === "partial" || j.status === "canceled").length;
  const needsInput = jobs.filter(j => j.status === "waiting_input").length;

  const isActive = running + needsInput > 0;

  // Outer is a `div` (not button) so we can nest the delete button. Opening
  // the store still works via the big clickable area below.
  return (
    <div
      className={
        "group relative border rounded-[6px] transition-colors bg-[#0d1117] " +
        (isActive
          ? "border-[#388bfd40] hover:border-[#388bfd80]"
          : "border-[#21262d] hover:border-[#30363d]")
      }
    >
      {onDelete && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="Delete store"
          className="absolute top-2 right-2 w-6 h-6 flex items-center justify-center rounded-[4px] text-[#6e7681] opacity-0 group-hover:opacity-100 hover:bg-[#21262d] hover:text-[#f85149] transition-opacity"
        >
          <Icon.x width="12" height="12"/>
        </button>
      )}
      <button
        onClick={onClick}
        className="w-full text-left p-4"
      >
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="min-w-0 pr-6">
            <div className="font-serif text-[22px] leading-[1.1] text-[#e6edf3] truncate">{store.name}</div>
            <div className="text-[11px] text-[#6e7681] mt-1">
              {store.lastImportedAt
                ? `Last imported ${relDate(new Date(store.lastImportedAt).toISOString())} ago`
                : "Never imported"}
            </div>
          </div>
          <div className="flex-shrink-0">
            {isActive ? (
              <span className="w-2 h-2 rounded-full bg-[#388bfd] animate-pulse inline-block"/>
            ) : (
              <Icon.chevronRight width="14" height="14" className="text-[#6e7681]"/>
            )}
          </div>
        </div>

        <div className="text-[11px] text-[#8b949e]">
          {jobs.length === 0 ? (
            <span className="text-[#6e7681]">no jobs yet</span>
          ) : (
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {running > 0 && <JobStat color="#388bfd" n={running} label="running" pulse/>}
              {needsInput > 0 && <JobStat color="#58a6ff" n={needsInput} label="needs input"/>}
              {completed > 0 && <JobStat color="#3fb950" n={completed} label="completed"/>}
              {failed > 0 && <JobStat color="#f85149" n={failed} label="failed"/>}
            </div>
          )}
        </div>
      </button>
    </div>
  );
}

function JobStat({ color, n, label, pulse }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={"w-1.5 h-1.5 rounded-full " + (pulse ? "animate-pulse" : "")} style={{ background: color }}/>
      <span className="tabular-nums text-[#e6edf3]">{n}</span>
      <span>{label}</span>
    </span>
  );
}

function AddStoreCard({ onClick }) {
  return (
    <button
      onClick={onClick}
      className="border border-dashed border-[#30363d] hover:border-[#388bfd] rounded-[6px] p-4 text-[#8b949e] hover:text-[#e6edf3] transition-colors flex flex-col items-center justify-center gap-1 min-h-[110px]"
    >
      <span className="text-[18px] leading-none">+</span>
      <span className="text-[12px]">Add store</span>
    </button>
  );
}

Object.assign(window, { Dashboard });

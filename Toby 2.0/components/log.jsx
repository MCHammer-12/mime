// Raw log drawer — full NDJSON-style event stream for a job, for the
// "I need to actually debug this" moments. Slides up from the bottom,
// doesn't steal main workspace.

function RawLogDrawer({ job, onClose }) {
  if (!job) return null;
  const events = job.log || [];

  return (
    <div className="fixed inset-x-0 bottom-0 h-[40vh] bg-[#010409] border-t border-[#30363d] z-50 flex flex-col shadow-[0_-10px_30px_rgba(0,0,0,0.4)]">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-[#21262d]">
        <span className="text-[11px] uppercase tracking-wider text-[#e6edf3]">
          Raw log · job #{job.shortId}
        </span>
        <span className="text-[11px] text-[#6e7681] tabular-nums">{events.length} events</span>
        <button
          onClick={() => {
            const text = events.map(e => JSON.stringify(e)).join("\n");
            navigator.clipboard?.writeText(text);
          }}
          className="text-[11px] text-[#8b949e] hover:text-[#e6edf3] ml-auto px-2 py-0.5 border border-[#30363d] rounded-[3px]"
        >copy NDJSON</button>
        <button onClick={onClose} className="text-[#6e7681] hover:text-[#e6edf3]">
          <Icon.x width="14" height="14"/>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-2 font-mono text-[11px] leading-[1.6]">
        {events.length === 0 ? (
          <div className="text-[#484f58] italic">No events yet…</div>
        ) : events.map((e, i) => (
          <div key={i} className="flex gap-3 hover:bg-[#161b22]">
            <span className="text-[#484f58] tabular-nums flex-shrink-0 w-12">{String(i + 1).padStart(4, "0")}</span>
            <span className={"flex-shrink-0 w-[72px] " + logKindColor(e.kind)}>{e.kind}</span>
            <span className="text-[#e6edf3] break-all">
              {formatLogEvent(e)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function logKindColor(kind) {
  return {
    step:          "text-[#8b949e]",
    exported:      "text-[#58a6ff]",
    imported:      "text-[#3fb950]",
    flow_imported: "text-[#3fb950]",
    fail:          "text-[#f85149]",
    warn:          "text-[#d29922]",
    done:          "text-[#a371f7]",
  }[kind] || "text-[#8b949e]";
}

function formatLogEvent(e) {
  const { kind, ...rest } = e;
  return JSON.stringify(rest);
}

window.RawLogDrawer = RawLogDrawer;

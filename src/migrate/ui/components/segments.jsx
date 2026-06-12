// Segments tab — Klaviyo dynamic segments → Redo dynamic segments.
//
// Self-contained: lists segments, lazily previews each one's translation
// ("here's our logic" for substitutions, what's dropped), then kicks a
// job-backed import that streams per-segment progress. Substitution-approval
// and tolerance-miss prompts surface through the shared NeedsInputModal; the
// ±10% count check runs server-side before each create.
//
// Per-file hook aliases (multiple <script> tags share window.React).
const { useState: useSg, useEffect: useSgE, useRef: useSgR, useCallback: useSgC } = React;

const TIER_COLOR = {
  exact: "text-[#3fb950]",
  substituted: "text-[#d29922]",
  unsupported: "text-[#f85149]",
};

function phaseLabel(p) {
  return {
    translating: "translating…",
    translated: "ready",
    waiting: "waiting for you…",
    verifying: "checking audience…",
    verified: "verified",
    created: "imported ✓",
    skipped: "skipped",
    failed: "failed",
  }[p] || p || "";
}

function phaseTone(p) {
  if (p === "created") return "text-[#3fb950]";
  if (p === "failed") return "text-[#f85149]";
  if (p === "skipped") return "text-[#8b949e]";
  if (p === "waiting") return "text-[#d29922]";
  return "text-[#58a6ff]";
}

async function* readNdjson(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    if (signal?.aborted) return;
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        try { yield JSON.parse(line); } catch { /* skip partial/non-JSON */ }
      }
    }
  }
}

function SegmentsTab({ creds }) {
  const [segments, setSegments] = useSg(null); // null = not loaded
  const [loading, setLoading] = useSg(false);
  const [error, setError] = useSg(null);
  const [filter, setFilter] = useSg("");
  const [selected, setSelected] = useSg(() => new Set());
  const [previews, setPreviews] = useSg({}); // id → preview | "loading" | {error}
  const [expanded, setExpanded] = useSg(() => new Set());
  const [aov, setAov] = useSg("100");
  const [tolerancePct, setTolerancePct] = useSg("10");

  // Job state
  const [job, setJob] = useSg(null); // {id, status} | null
  const [perSeg, setPerSeg] = useSg({}); // id → {name, phase, tiers, verify, redoId, reason, error, droppedList, substitutions}
  const [log, setLog] = useSg([]);
  const [pending, setPending] = useSg(null); // NeedsInputModal question
  const abortRef = useSgR(null);

  const hasKey = !!creds?.klaviyoKey;
  const hasJwt = !!creds?.redoJwt;

  const loadList = useSgC(async () => {
    if (!hasKey) { setError("This store has no Klaviyo key — add one in the credentials editor."); return; }
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/segments/list", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ klaviyoKey: creds.klaviyoKey }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setSegments(j.segments || []);
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, [creds, hasKey]);

  const loadPreview = useSgC(async (id) => {
    setPreviews(p => ({ ...p, [id]: "loading" }));
    try {
      const r = await fetch("/api/segments/preview", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ klaviyoKey: creds.klaviyoKey, segmentId: id, aov: Number(aov) || undefined }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setPreviews(p => ({ ...p, [id]: j }));
    } catch (e) { setPreviews(p => ({ ...p, [id]: { error: e.message || String(e) } })); }
  }, [creds, aov]);

  const toggleExpand = (id) => {
    setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    if (!previews[id]) loadPreview(id);
  };
  const toggleSelect = (id) => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Stream a job's events into perSeg/log/pending.
  const streamJob = useSgC(async (jobId) => {
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const resp = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/stream?since=0`, { signal: ac.signal });
      for await (const evt of readNdjson(resp, ac.signal)) {
        const k = evt.kind;
        const p = evt.payload || evt; // job events wrap fields in payload
        if (k === "heartbeat") continue;
        if (k === "needs_input") {
          const q = p.input || {};
          // mark the segment as waiting
          if (q.itemId) setPerSeg(s => ({ ...s, [q.itemId]: { ...(s[q.itemId] || {}), phase: "waiting" } }));
          setPending({
            qid: q.id, itemName: q.itemLabel, question: q.question, context: q.context,
            type: q.type, options: q.options, default: q.default,
            trueLabel: q.trueLabel, falseLabel: q.falseLabel, hideApplyAll: q.hideApplyAll,
            jobId,
          });
        } else if (k === "segment_start") {
          setPerSeg(s => ({ ...s, [p.id]: { ...(s[p.id] || {}), name: p.name, profileCount: p.profileCount, phase: "translating" } }));
        } else if (k === "segment_translated") {
          setPerSeg(s => ({ ...s, [p.id]: { ...(s[p.id] || {}), name: p.name, phase: "translated",
            tiers: { exact: p.exact, substituted: p.substituted, dropped: p.dropped },
            importable: p.importable, partial: p.partial, droppedList: p.droppedList } }));
        } else if (k === "segment_verified") {
          setPerSeg(s => ({ ...s, [p.id]: { ...(s[p.id] || {}), phase: "verified",
            verify: { klaviyoCount: p.klaviyoCount, redoCount: p.redoCount, deltaPct: p.deltaPct, withinTolerance: p.withinTolerance, tuned: p.tuned } } }));
        } else if (k === "segment_created") {
          setPerSeg(s => ({ ...s, [p.id]: { ...(s[p.id] || {}), phase: "created", redoId: p.redoId, redoCount: p.redoCount, partial: p.partial } }));
        } else if (k === "segment_skipped") {
          setPerSeg(s => ({ ...s, [p.id]: { ...(s[p.id] || {}), phase: "skipped", reason: p.reason } }));
        } else if (k === "segment_failed") {
          setPerSeg(s => ({ ...s, [p.id]: { ...(s[p.id] || {}), phase: "failed", error: p.error } }));
        } else if (k === "info" || k === "warn") {
          setLog(l => [...l, { sev: k, text: p.text }]);
        } else if (k === "error") {
          setLog(l => [...l, { sev: "error", text: p.text }]);
        } else if (k === "done") {
          setLog(l => [...l, { sev: "info", text: `Done — ${p.segmentsCreated} created, ${p.segmentsSkipped} skipped, ${p.segmentsFailed} failed.` }]);
          setJob(j => j ? { ...j, status: "completed" } : j);
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") setLog(l => [...l, { sev: "error", text: `stream error: ${e.message || e}` }]);
    } finally {
      setJob(j => j && j.status !== "completed" ? { ...j, status: "ended" } : j);
    }
  }, []);

  const startImport = useSgC(async () => {
    if (!hasJwt) { setError("This store has no Redo session token — add one in the credentials editor."); return; }
    const ids = [...selected];
    if (ids.length === 0) return;
    setPerSeg({}); setLog([]); setPending(null); setError(null);
    try {
      const r = await fetch("/api/jobs", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          segmentIds: ids,
          klaviyoKey: creds.klaviyoKey,
          redoJwt: creds.redoJwt,
          redoServerBase: creds.redoServerBase || undefined,
          storeId: creds.storeId, storeName: creds.storeName, merchantSlug: creds.merchantSlug,
          aov: Number(aov) || undefined,
          tolerance: (Number(tolerancePct) || 10) / 100,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setJob({ id: j.jobId, status: "running" });
      streamJob(j.jobId);
    } catch (e) { setError(e.message || String(e)); }
  }, [creds, selected, aov, tolerancePct, hasJwt, streamJob]);

  const answer = useSgC(async (value) => {
    const q = pending; if (!q) return;
    setPending(null);
    try {
      await fetch(`/api/jobs/${encodeURIComponent(q.jobId)}/inputs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ inputId: q.qid, answer: value }),
      });
    } catch (e) { setLog(l => [...l, { sev: "error", text: `answer failed: ${e.message || e}` }]); }
  }, [pending]);

  useSgE(() => () => { abortRef.current?.abort(); }, []);

  const visible = (segments || []).filter(s =>
    !filter || (s.name || "").toLowerCase().includes(filter.toLowerCase()));
  const running = job && job.status === "running";

  return (
    <div className="h-full flex flex-col">
      {/* Controls */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-[#21262d] bg-[#0d1117] flex-wrap">
        {segments === null ? (
          <button onClick={loadList} disabled={loading || !hasKey}
            className="text-[12px] font-medium text-white bg-[#238636] hover:bg-[#2ea043] disabled:bg-[#21262d] disabled:text-[#6e7681] px-3 py-1.5 rounded-[4px] border border-[#2ea043]">
            {loading ? "Loading…" : "Load segments"}
          </button>
        ) : (
          <>
            <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter…"
              className="bg-[#010409] border border-[#30363d] rounded-[4px] px-2 py-1 text-[12px] text-[#e6edf3] w-[160px] focus:outline-none focus:border-[#58a6ff]" />
            <span className="text-[11px] text-[#6e7681]">{visible.length} segments · {selected.size} selected</span>
            <label className="text-[11px] text-[#8b949e] flex items-center gap-1 ml-2">
              AOV $<input value={aov} onChange={e => setAov(e.target.value)} className="bg-[#010409] border border-[#30363d] rounded px-1 py-0.5 w-[52px] text-[#e6edf3] text-[11px]" />
            </label>
            <label className="text-[11px] text-[#8b949e] flex items-center gap-1">
              tol ±<input value={tolerancePct} onChange={e => setTolerancePct(e.target.value)} className="bg-[#010409] border border-[#30363d] rounded px-1 py-0.5 w-[36px] text-[#e6edf3] text-[11px]" />%
            </label>
            <button onClick={startImport} disabled={selected.size === 0 || running || !hasJwt}
              className="ml-auto text-[12px] font-medium text-white bg-[#238636] hover:bg-[#2ea043] disabled:bg-[#21262d] disabled:text-[#6e7681] px-3 py-1.5 rounded-[4px] border border-[#2ea043]">
              {running ? "Importing…" : `Import ${selected.size || ""} segment${selected.size === 1 ? "" : "s"}`}
            </button>
          </>
        )}
      </div>

      {!hasJwt && segments !== null && (
        <div className="px-4 py-1.5 text-[11px] text-[#d29922] bg-[#161b22] border-b border-[#21262d]">
          No Redo session token for this store — preview works, but import is disabled until you add a JWT in the credentials editor.
        </div>
      )}
      {error && <div className="px-4 py-1.5 text-[11px] text-[#f85149] bg-[#161b22] border-b border-[#21262d]">{error}</div>}

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {segments === null ? (
          <div className="px-4 py-8 text-[12px] text-[#6e7681] text-center">
            {hasKey ? "Click “Load segments” to fetch this store's Klaviyo segments." : "Add a Klaviyo key to this store first."}
          </div>
        ) : visible.length === 0 ? (
          <div className="px-4 py-8 text-[12px] text-[#6e7681] text-center">No segments match.</div>
        ) : visible.map(s => (
          <SegmentRow key={s.id} seg={s}
            selected={selected.has(s.id)} onToggle={() => toggleSelect(s.id)}
            expanded={expanded.has(s.id)} onExpand={() => toggleExpand(s.id)}
            preview={previews[s.id]} progress={perSeg[s.id]} />
        ))}
      </div>

      {/* Log */}
      {log.length > 0 && (
        <div className="max-h-[120px] overflow-y-auto border-t border-[#21262d] bg-[#010409] px-4 py-2 text-[11px] font-mono">
          {log.map((l, i) => (
            <div key={i} className={l.sev === "error" ? "text-[#f85149]" : l.sev === "warn" ? "text-[#d29922]" : "text-[#8b949e]"}>{l.text}</div>
          ))}
        </div>
      )}

      {pending && window.NeedsInputModal && (
        <window.NeedsInputModal question={pending} onAnswer={(v) => answer(v)} onSkip={() => answer("__skip__")} />
      )}
    </div>
  );
}

function SegmentRow({ seg, selected, onToggle, expanded, onExpand, preview, progress }) {
  const ph = progress?.phase;
  return (
    <div className="border-b border-[#161b22]">
      <div className="flex items-center gap-3 px-4 py-2 hover:bg-[#0d1117]">
        <input type="checkbox" checked={selected} onChange={onToggle} className="w-3.5 h-3.5 accent-[#58a6ff] cursor-pointer" />
        <button onClick={onExpand} className="text-[13px] text-[#e6edf3] hover:text-[#58a6ff] text-left flex-1 truncate">
          {seg.name || seg.id}
        </button>
        {ph && <span className={"text-[11px] " + phaseTone(ph)}>{phaseLabel(ph)}</span>}
        {progress?.verify && (
          <span className="text-[10px] text-[#6e7681] tabular-nums">
            K {progress.verify.klaviyoCount ?? "?"} · R {progress.verify.redoCount}
            {progress.verify.deltaPct != null && (
              <span className={progress.verify.withinTolerance ? "text-[#3fb950]" : "text-[#f85149]"}> · {(progress.verify.deltaPct * 100).toFixed(1)}%</span>
            )}
          </span>
        )}
        {progress?.redoId && <span className="text-[10px] text-[#3fb950] font-mono">→ {String(progress.redoId).slice(-8)}</span>}
        <button onClick={onExpand} className="text-[10px] text-[#6e7681] hover:text-[#e6edf3]">{expanded ? "▾" : "▸"}</button>
      </div>

      {expanded && (
        <div className="px-10 pb-3 text-[11px]">
          {preview === "loading" ? (
            <div className="text-[#6e7681]">translating…</div>
          ) : preview?.error ? (
            <div className="text-[#f85149]">{preview.error}</div>
          ) : preview ? (
            <div className="space-y-1.5">
              <div className="flex gap-3 text-[10px]">
                <span className={TIER_COLOR.exact}>{preview.tiers.exact} exact</span>
                <span className={TIER_COLOR.substituted}>{preview.tiers.substituted} substituted</span>
                <span className={TIER_COLOR.unsupported}>{preview.tiers.unsupported} unsupported</span>
                {preview.klaviyoCount != null && <span className="text-[#6e7681] ml-auto">Klaviyo: {preview.klaviyoCount.toLocaleString()}</span>}
                {!preview.importable && <span className="text-[#f85149]">not importable</span>}
              </div>
              {preview.substitutions.map((s, i) => (
                <div key={i} className="border-l-2 border-[#d29922] pl-2 text-[#c9d1d9]">
                  <span className="text-[#d29922]">substitute</span> {s.klaviyoSummary}
                  <div className="text-[#8b949e]">→ {s.redoLogic}</div>
                </div>
              ))}
              {(progress?.droppedList || preview.dropped).map((d, i) => (
                <div key={i} className="border-l-2 border-[#f85149] pl-2 text-[#8b949e]">
                  <span className="text-[#f85149]">drop</span> {d.klaviyoType}{d.dimension ? ` [${d.dimension}]` : ""} — {d.reason}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[#6e7681]">expand to preview translation</div>
          )}
          {progress?.error && <div className="text-[#f85149] mt-1">{progress.error}</div>}
          {progress?.reason && <div className="text-[#8b949e] mt-1">skipped: {progress.reason}</div>}
        </div>
      )}
    </div>
  );
}

window.SegmentsTab = SegmentsTab;

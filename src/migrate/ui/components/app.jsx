// Main app. Routes between Dashboard and Migration screens.
// Jobs are app-level state with storeId — they persist across navigation
// and all stores' jobs remain visible on the Dashboard.

const { useState: useS, useEffect: useE, useMemo: useM, useCallback: useC, useRef: useR } = React;

// Classify a warning message into a category (for side-panel grouping).
function classifyWarning(text) {
  const s = (text || "").toLowerCase();
  if (s.startsWith("profile-")) return "Condition translation";
  if (s.includes("unmapped") || s.includes("token")) return "Variable mapping";
  if (s.includes("degraded") || s.includes("fallback")) return "Degraded mapping";
  if (s.includes("skipped") || s.includes("not yet")) return "Skipped step";
  if (s.includes("review")) return "Review in Redo";
  return "Other";
}
window.classifyWarning = classifyWarning;

function App() {
  // ─ Stores ─ (persisted to localStorage via mock-stores.js)
  const [stores, setStoresState] = useS(window.MOCK_STORES);
  const setStores = (updater) =>
    setStoresState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      window.saveStores?.(next);
      return next;
    });

  const [view, setView] = useS({ screen: "dashboard", storeId: null });
  const [showAddStore, setShowAddStore] = useS(false);

  // ─ Per-store data catalogs, fetched on demand ─
  // Each entry: { flows, templates, loading, error, loaded }
  const [storeDataMap, setStoreDataMap] = useS({});
  const EMPTY_DATA = { flows: [], templates: [], loading: false, error: null, loaded: false };
  const data = view.storeId
    ? (storeDataMap[view.storeId] || EMPTY_DATA)
    : EMPTY_DATA;

  // Fetch flows + templates when the user opens a store's migration view.
  useE(() => {
    if (view.screen !== "migration" || !view.storeId) return;
    const store = stores.find((s) => s.id === view.storeId);
    if (!store) return;
    if (storeDataMap[view.storeId]?.loaded) return; // already fetched

    setStoreDataMap((m) => ({
      ...m,
      [view.storeId]: { ...EMPTY_DATA, loading: true },
    }));
    window
      .fetchStoreData(store)
      .then((res) => {
        setStoreDataMap((m) => ({
          ...m,
          [view.storeId]: {
            flows: res.flows ?? [],
            templates: res.templates ?? [],
            loading: false,
            error: null,
            loaded: true,
          },
        }));
      })
      .catch((e) => {
        setStoreDataMap((m) => ({
          ...m,
          [view.storeId]: {
            ...EMPTY_DATA,
            loading: false,
            error: e?.message ?? String(e),
            loaded: true,
          },
        }));
      });
  }, [view.screen, view.storeId, stores]);

  // ─ Per-store session imported (prior imports + current session) ─
  // Keyed by storeId for correct scope.
  const [sessionImports, setSessionImports] = useS({}); // {storeId: {flows: Set, tmpls: Set}}
  const [lastResult, setLastResult] = useS({});         // {storeId: Map<id, "imported"|"failed">}
  const [inProgress, setInProgress] = useS({});         // {storeId: Set<id>}

  // ─ Per-store selection + filters ─
  const [perStore, setPerStore] = useS({}); // {storeId: {tab, flowFilter, tmplFilter, flowStatus, hideFlow, hideTmpl, selectedFlowIds, selectedTmplIds}}

  // ─ Jobs (flat, app-level — each has storeId) ─
  const [jobs, setJobs] = useS([]);
  const [panelCollapsed, setPanelCollapsed] = useS(false);
  const [logJobId, setLogJobId] = useS(null);
  const [warningsView, setWarningsView] = useS(null); // {jobId, itemId}

  // ─ Pending needs_input question (single modal at a time) ─
  const [pendingInput, setPendingInput] = useS(null); // {jobId, qid, itemId, itemName, question, options, broker}

  const getStoreState = (storeId) => perStore[storeId] || {
    tab: "flows",
    flowFilter: "", tmplFilter: "",
    flowStatus: "all",
    hideFlow: true, hideTmpl: true,
    selectedFlowIds: new Set(), selectedTmplIds: new Set(),
  };
  const updateStoreState = (storeId, patch) => {
    setPerStore(ps => ({ ...ps, [storeId]: { ...getStoreState(storeId), ...(typeof patch === "function" ? patch(getStoreState(storeId)) : patch) } }));
  };

  const getStoreImports = (storeId) => sessionImports[storeId] || {
    flows: new Set([...window.PRIOR_IMPORTED_FLOW_IDS]),
    tmpls: new Set([...window.PRIOR_IMPORTED_TEMPLATE_IDS]),
  };

  // ─ Add store ─
  const addStore = (data) => {
    const newStore = {
      id: `str_${Date.now().toString(36)}`,
      name: data.name,
      klaviyoKey: data.klaviyoKey,
      redoToken: data.redoToken,
      decodedStoreId: data.decodedStoreId,
      createdAt: Date.now(),
      lastImportedAt: null,
    };
    setStores(s => [...s, newStore]);
    setShowAddStore(false);
  };

  // ─ Navigation ─
  const openStore = (storeId) => setView({ screen: "migration", storeId });
  const goDashboard = () => setView({ screen: "dashboard", storeId: null });

  // ─ Import ─
  const startImport = useC((storeId) => {
    const store = stores.find(s => s.id === storeId);
    if (!store) return;
    const ss = getStoreState(storeId);
    const totalSel = ss.selectedFlowIds.size + ss.selectedTmplIds.size;
    if (totalSel === 0) return;

    const jobId = `j_${Date.now()}`;
    const jobsInStore = jobs.filter(j => j.storeId === storeId).length;
    const shortId = `#${String(jobsInStore + 1).padStart(3, "0")}`;
    const abort = new AbortController();
    const broker = window.makeAnswerBroker();

    const flowIds = [...ss.selectedFlowIds];
    const templateIds = [...ss.selectedTmplIds];

    const items = [
      ...templateIds.map(id => {
        const t = data.templates.find(x => x.id === id);
        return { id, name: t?.name || id, kind: "template", state: "queued" };
      }),
      ...flowIds.map(id => {
        const f = data.flows.find(x => x.flowId === id);
        return { id, name: f?.flowName || id, kind: "flow", state: "queued" };
      }),
    ];

    const job = {
      id: jobId, shortId,
      storeId,
      storeName: store.name,
      startedAt: Date.now(), endedAt: null,
      status: "running",
      items,
      templateCount: templateIds.length, flowCount: flowIds.length,
      currentStep: "", warnings: [], infos: [],
      fatalError: null, fontsDone: null, exportSummary: null, importMethod: null,
      log: [], abort, broker,
    };

    setJobs(js => [job, ...js]);
    setInProgress(ip => ({ ...ip, [storeId]: new Set([...(ip[storeId] || []), ...items.map(i => i.id)]) }));
    updateStoreState(storeId, { selectedFlowIds: new Set(), selectedTmplIds: new Set() });

    // Update store lastImportedAt
    setStores(ss => ss.map(s => s.id === storeId ? { ...s, lastImportedAt: Date.now() } : s));

    (async () => {
      try {
        const stream = window.mockRunStream({
          templateIds, flowIds,
          flows: data.flows, templates: data.templates,
          signal: abort.signal,
          store,                           // carries klaviyoKey + redoToken + decodedStoreId
          storeName: store.name,
          merchantSlug: store.merchantSlug || store.name,
          answerBroker: broker,
        });
        for await (const evt of stream) applyEvent(jobId, evt);
      } catch (e) {
        applyEvent(jobId, { kind: "error", text: e?.message ?? String(e) });
      }
    })();
  }, [stores, perStore, jobs, data]);

  const applyEvent = useC((jobId, evt) => {
    setJobs(js => js.map(j => {
      if (j.id !== jobId) return j;
      const log = [...j.log, evt];
      let items = j.items;
      let currentStep = j.currentStep;
      let warnings = j.warnings;
      let infos = j.infos || [];
      let fatalError = j.fatalError;
      let fontsDone = j.fontsDone;
      let exportSummary = j.exportSummary;
      let status = j.status;
      let endedAt = j.endedAt;
      let importMethod = j.importMethod;
      let pendingQid = j.pendingQid;

      if (evt.kind === "step") currentStep = evt.label;
      else if (evt.kind === "info") infos = [...infos, evt.text];
      else if (evt.kind === "error") fatalError = evt.text;
      else if (evt.kind === "needs_input") {
        status = "waiting_input";
        pendingQid = evt.qid;
        items = items.map(i => i.id === evt.itemId ? { ...i, state: "waiting_input" } : i);
        // Surface modal
        setPendingInput({
          jobId,
          qid: evt.qid, itemId: evt.itemId, itemName: evt.itemName,
          question: evt.question, options: evt.options,
          type: evt.type, default: evt.default, placeholder: evt.placeholder,
          context: evt.context, trueLabel: evt.trueLabel, falseLabel: evt.falseLabel,
          broker: j.broker,
        });
      } else if (evt.kind === "exported") {
        const parts = [`${evt.sectionCount} sections`];
        if (evt.warnings) parts.push(`${evt.warnings} warn`);
        if (evt.unsupported) parts.push(`${evt.unsupported} unsupported`);
        if (evt.aiRewrites) parts.push(`${evt.aiRewrites} AI rewrite${evt.aiRewrites === 1 ? '' : 's'}`);
        items = items.map(i => i.id === evt.id ? { ...i, state: "running", detail: parts.join(" · ") } : i);
        if (status === "waiting_input") status = "running";
      } else if (evt.kind === "summary") {
        exportSummary = { exported: evt.exported, failed: evt.failed };
      } else if (evt.kind === "fonts_done") {
        fontsDone = evt;
      } else if (evt.kind === "imported") {
        items = items.map(i => i.id === evt.id ? { ...i, state: "imported", detail: `→ ${evt.templateId.slice(-8)}` } : i);
        setSessionImports(si => {
          const cur = si[j.storeId] || { flows: new Set([...window.PRIOR_IMPORTED_FLOW_IDS]), tmpls: new Set([...window.PRIOR_IMPORTED_TEMPLATE_IDS]) };
          return { ...si, [j.storeId]: { ...cur, tmpls: new Set([...cur.tmpls, evt.id]) } };
        });
        setLastResult(lr => ({ ...lr, [j.storeId]: new Map([...(lr[j.storeId] || new Map())]).set(evt.id, "imported") }));
        setInProgress(ip => { const n = new Set(ip[j.storeId] || []); n.delete(evt.id); return { ...ip, [j.storeId]: n }; });
      } else if (evt.kind === "flow_imported") {
        const parts = [`${evt.createdTemplateCount} email${evt.createdTemplateCount === 1 ? '' : 's'}`];
        if (evt.blankTemplateCount) parts.push(`${evt.blankTemplateCount} blank`);
        if (evt.warningCount) parts.push(`${evt.warningCount} warn`);
        items = items.map(i => i.id === evt.id ? { ...i, state: "imported", detail: parts.join(" · ") } : i);
        setSessionImports(si => {
          const cur = si[j.storeId] || { flows: new Set([...window.PRIOR_IMPORTED_FLOW_IDS]), tmpls: new Set([...window.PRIOR_IMPORTED_TEMPLATE_IDS]) };
          return { ...si, [j.storeId]: { ...cur, flows: new Set([...cur.flows, evt.id]) } };
        });
        setLastResult(lr => ({ ...lr, [j.storeId]: new Map([...(lr[j.storeId] || new Map())]).set(evt.id, "imported") }));
        setInProgress(ip => { const n = new Set(ip[j.storeId] || []); n.delete(evt.id); return { ...ip, [j.storeId]: n }; });
      } else if (evt.kind === "fail") {
        items = items.map(i => i.id === evt.id ? { ...i, state: "failed", error: evt.error } : i);
        setLastResult(lr => ({ ...lr, [j.storeId]: new Map([...(lr[j.storeId] || new Map())]).set(evt.id, "failed") }));
        setInProgress(ip => { const n = new Set(ip[j.storeId] || []); n.delete(evt.id); return { ...ip, [j.storeId]: n }; });
      } else if (evt.kind === "warn") {
        if (evt.itemId) {
          items = items.map(i => i.id === evt.itemId
            ? { ...i, itemWarnings: [...(i.itemWarnings || []), { text: evt.text, category: classifyWarning(evt.text) }] }
            : i);
        } else {
          warnings = [...warnings, evt.text];
        }
      } else if (evt.kind === "done") {
        status = (evt.importFailed + evt.flowsFailed) > 0 ? "partial" : "complete";
        endedAt = Date.now();
        currentStep = "";
        importMethod = evt.importMethod;
        items = items.map(i => i.state === "queued" || i.state === "running" ? { ...i, state: "imported" } : i);
      }

      return { ...j, items, currentStep, warnings, infos, fatalError, fontsDone, exportSummary, status, endedAt, log, importMethod, pendingQid };
    }));
  }, []);

  const answerNeedsInput = useC((answer, applyAll) => {
    if (!pendingInput) return;
    pendingInput.broker.submit(pendingInput.qid, answer, applyAll);
    setPendingInput(null);
  }, [pendingInput]);

  const skipNeedsInput = useC(() => {
    if (!pendingInput) return;
    pendingInput.broker.submit(pendingInput.qid, "__skip__", false);
    setPendingInput(null);
  }, [pendingInput]);

  const retryItem = useC(async (jobId, item) => {
    setJobs(js => js.map(j => j.id !== jobId ? j : ({
      ...j,
      items: j.items.map(i => i.id === item.id ? { ...i, retrying: true, state: "running", error: null } : i),
    })));
    const job = jobs.find(j => j.id === jobId);
    const storeId = job?.storeId;
    const store = stores.find(s => s.id === storeId);
    if (storeId) setInProgress(ip => ({ ...ip, [storeId]: new Set([...(ip[storeId] || []), item.id]) }));

    const flow = data.flows.find(f => f.flowId === item.id);
    const broker = job?.broker ?? window.makeAnswerBroker();
    try {
      const stream = window.mockRetryStream({
        id: item.id,
        name: item.name,
        kind: item.kind,
        flow,
        store,
        storeName: store?.name,
        merchantSlug: store?.merchantSlug || store?.name,
        answerBroker: broker,
      });
      for await (const evt of stream) applyEvent(jobId, evt);
    } catch (e) {
      applyEvent(jobId, { kind: "error", text: e?.message ?? String(e) });
    }
    setJobs(js => js.map(j => j.id !== jobId ? j : ({
      ...j,
      items: j.items.map(i => i.id === item.id ? { ...i, retrying: false } : i),
    })));
  }, [jobs, stores, data, applyEvent]);

  const dismissJob = useC((jobId) => {
    setJobs(js => js.filter(j => j.id !== jobId));
  }, []);
  const cancelJob = useC((jobId) => {
    setJobs(js => js.map(j => {
      if (j.id !== jobId) return j;
      j.abort?.abort();
      return {
        ...j,
        status: "canceled",
        endedAt: Date.now(),
        items: j.items.map(i => i.state === "queued" || i.state === "waiting_input" ? { ...i, state: "failed", error: "canceled" } : i),
      };
    }));
  }, []);

  // ─ Render ─
  const activeStore = view.storeId ? stores.find(s => s.id === view.storeId) : null;

  return (
    <div className="h-screen w-screen flex flex-col bg-[#0d1117] text-[#e6edf3] font-sans">
      <TopBar
        view={view}
        store={activeStore}
        onGoDashboard={goDashboard}
      />

      <div className="flex flex-1 overflow-hidden">
        {view.screen === "dashboard" ? (
          <Dashboard
            stores={stores}
            jobs={jobs}
            onOpenStore={openStore}
            onAddStore={() => setShowAddStore(true)}
          />
        ) : (
          <MigrationScreen
            store={activeStore}
            data={data}
            state={getStoreState(activeStore.id)}
            updateState={(patch) => updateStoreState(activeStore.id, patch)}
            imports={getStoreImports(activeStore.id)}
            lastResult={lastResult[activeStore.id] || new Map()}
            inProgress={inProgress[activeStore.id] || new Set()}
            onImport={() => startImport(activeStore.id)}
          />
        )}

        <JobsPanel
          jobs={view.screen === "dashboard" ? jobs : jobs.filter(j => j.storeId === view.storeId)}
          scopeLabel={view.screen === "dashboard" ? "all stores" : activeStore?.name}
          collapsed={panelCollapsed}
          onToggleCollapsed={() => setPanelCollapsed(c => !c)}
          onRetryItem={retryItem}
          onDismissJob={dismissJob}
          onCancelJob={cancelJob}
          onOpenLog={setLogJobId}
          onOpenWarnings={(jobId, itemId) => setWarningsView({ jobId, itemId })}
        />
      </div>

      {showAddStore && (
        <SetupModal onSave={addStore} onClose={() => setShowAddStore(false)} />
      )}
      {pendingInput && (
        <NeedsInputModal
          question={pendingInput}
          onAnswer={answerNeedsInput}
          onSkip={skipNeedsInput}
        />
      )}

      <RawLogDrawer job={jobs.find(j => j.id === logJobId)} onClose={() => setLogJobId(null)}/>
      {warningsView && (
        <WarningsPanel
          job={jobs.find(j => j.id === warningsView.jobId)}
          startItemId={warningsView.itemId}
          onClose={() => setWarningsView(null)}
        />
      )}
    </div>
  );
}

function TopBar({ view, store, onGoDashboard }) {
  const [hosted, setHosted] = React.useState(!!(window.mockEnv && window.mockEnv.hostedDeploy));
  const toggleHosted = () => {
    const next = !hosted;
    window.mockEnv = { ...(window.mockEnv || {}), hostedDeploy: next };
    setHosted(next);
  };
  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-[#21262d] bg-[#010409]">
      <div className="flex items-baseline gap-2">
        <span className="font-serif text-[22px] leading-none text-[#e6edf3]">Toby</span>
        <span className="font-serif italic text-[16px] leading-none text-[#FF4405]">2.0</span>
        <span className="text-[11px] text-[#6e7681] ml-1">· Klaviyo → Redo</span>
      </div>
      <span className="text-[10px] uppercase tracking-wider text-[#6e7681] px-2 py-0.5 border border-[#30363d] rounded-[3px] ml-2">
        internal · ops
      </span>
      <div className="flex items-center gap-2 text-[12px] ml-3">
        <button
          onClick={onGoDashboard}
          className={view.screen === "dashboard" ? "text-[#e6edf3]" : "text-[#8b949e] hover:text-[#e6edf3]"}
        >Dashboard</button>
        {view.screen === "migration" && store && (
          <>
            <span className="text-[#484f58]">/</span>
            <span className="font-serif text-[16px] leading-none text-[#e6edf3]">{store.name}</span>
          </>
        )}
      </div>
      <div className="ml-auto text-[11px] text-[#6e7681] flex items-center gap-3">
        <button
          onClick={toggleHosted}
          title="Toggle GET /api/env.hostedDeploy for the next Add-store modal"
          className="flex items-center gap-1.5 px-1.5 py-0.5 border border-[#30363d] rounded-[3px] hover:border-[#484f58] hover:text-[#e6edf3]"
        >
          <span>env:</span>
          <span className={hosted ? "text-[#3fb950]" : "text-[#d29922]"}>
            {hosted ? "prod" : "dev"}
          </span>
        </button>
        <span>AI: <span className="text-[#3fb950]">on</span></span>
      </div>
    </div>
  );
}

function MigrationScreen({ store, data, state, updateState, imports, lastResult, inProgress, onImport }) {
  const visibleFlows = useM(() => data.flows.filter(f => {
    if (state.flowStatus !== "all" && f.flowStatus !== state.flowStatus) return false;
    if (state.flowFilter && !f.flowName.toLowerCase().includes(state.flowFilter.toLowerCase())) return false;
    if (state.hideFlow && imports.flows.has(f.flowId)) return false;
    return true;
  }), [data.flows, state.flowStatus, state.flowFilter, state.hideFlow, imports.flows]);

  const visibleTmpls = useM(() => data.templates.filter(t => {
    if (state.tmplFilter && !t.name.toLowerCase().includes(state.tmplFilter.toLowerCase())) return false;
    if (state.hideTmpl && imports.tmpls.has(t.id)) return false;
    return true;
  }), [data.templates, state.tmplFilter, state.hideTmpl, imports.tmpls]);

  const flowsAlreadyCount = useM(() => data.flows.filter(f => imports.flows.has(f.flowId)).length, [data.flows, imports.flows]);
  const tmplsAlreadyCount = useM(() => data.templates.filter(t => imports.tmpls.has(t.id)).length, [data.templates, imports.tmpls]);

  const toggleFlow = (id) => updateState(s => ({
    selectedFlowIds: new Set(s.selectedFlowIds.has(id)
      ? [...s.selectedFlowIds].filter(x => x !== id)
      : [...s.selectedFlowIds, id]),
  }));
  const toggleTmpl = (id) => updateState(s => ({
    selectedTmplIds: new Set(s.selectedTmplIds.has(id)
      ? [...s.selectedTmplIds].filter(x => x !== id)
      : [...s.selectedTmplIds, id]),
  }));

  const toggleAllFlows = () => {
    const allSel = visibleFlows.every(f => state.selectedFlowIds.has(f.flowId));
    updateState(s => {
      const n = new Set(s.selectedFlowIds);
      if (allSel) visibleFlows.forEach(f => n.delete(f.flowId));
      else visibleFlows.forEach(f => n.add(f.flowId));
      return { selectedFlowIds: n };
    });
  };
  const toggleAllTmpls = () => {
    const allSel = visibleTmpls.every(t => state.selectedTmplIds.has(t.id));
    updateState(s => {
      const n = new Set(s.selectedTmplIds);
      if (allSel) visibleTmpls.forEach(t => n.delete(t.id));
      else visibleTmpls.forEach(t => n.add(t.id));
      return { selectedTmplIds: n };
    });
  };

  const clearSelection = () => updateState({ selectedFlowIds: new Set(), selectedTmplIds: new Set() });
  const totalSelected = state.selectedFlowIds.size + state.selectedTmplIds.size;

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0">
      <Tabs
        tab={state.tab} onChange={(t) => updateState({ tab: t })}
        flowCount={data.flows.length} tmplCount={data.templates.length}
        flowSelCount={state.selectedFlowIds.size} tmplSelCount={state.selectedTmplIds.size}
      />

      {totalSelected > 0 && (
        <SelectionBar
          flowCount={state.selectedFlowIds.size} tmplCount={state.selectedTmplIds.size}
          onClear={clearSelection} onImport={onImport}
        />
      )}

      <div className="flex-1 overflow-hidden">
        {state.tab === "flows" ? (
          <ListShell
            items={visibleFlows} selectedIds={state.selectedFlowIds}
            onToggle={toggleFlow} onToggleAll={toggleAllFlows}
            filter={state.flowFilter} onFilterChange={(v) => updateState({ flowFilter: v })}
            statusFilter={state.flowStatus} onStatusFilterChange={(v) => updateState({ flowStatus: v })}
            statuses={["live", "draft", "manual", "disabled"]}
            hideAlreadyImported={state.hideFlow} onHideAlreadyImportedChange={(v) => updateState({ hideFlow: v })}
            alreadyImportedCount={flowsAlreadyCount}
            countLabel={`${data.flows.length} flows`}
            emptyText={
              data.loading
                ? "Loading flows from Klaviyo…"
                : data.error
                ? `Error: ${data.error}`
                : "No flows match these filters."
            }
            renderRow={(flow, selected, toggle) => (
              <FlowRow key={flow.flowId} flow={flow} selected={selected} onToggle={toggle}
                alreadyImported={imports.flows.has(flow.flowId)}
                inProgress={inProgress.has(flow.flowId)}
                lastResult={lastResult.get(flow.flowId)}/>
            )}
          />
        ) : (
          <ListShell
            items={visibleTmpls} selectedIds={state.selectedTmplIds}
            onToggle={toggleTmpl} onToggleAll={toggleAllTmpls}
            filter={state.tmplFilter} onFilterChange={(v) => updateState({ tmplFilter: v })}
            hideAlreadyImported={state.hideTmpl} onHideAlreadyImportedChange={(v) => updateState({ hideTmpl: v })}
            alreadyImportedCount={tmplsAlreadyCount}
            countLabel={`${data.templates.length} templates`}
            emptyText={
              data.loading
                ? "Loading templates from Klaviyo…"
                : data.error
                ? `Error: ${data.error}`
                : "No templates match these filters."
            }
            renderRow={(tmpl, selected, toggle) => (
              <TemplateRow key={tmpl.id} template={tmpl} selected={selected} onToggle={toggle}
                alreadyImported={imports.tmpls.has(tmpl.id)}
                inProgress={inProgress.has(tmpl.id)}
                lastResult={lastResult.get(tmpl.id)}/>
            )}
          />
        )}
      </div>
    </div>
  );
}

function Tabs({ tab, onChange, flowCount, tmplCount, flowSelCount, tmplSelCount }) {
  const mk = (key, label, count, selCount) => (
    <button
      onClick={() => onChange(key)}
      className={
        "px-4 py-2 text-[12px] border-b-2 -mb-px flex items-center gap-2 " +
        (tab === key ? "border-[#f78166] text-[#e6edf3]" : "border-transparent text-[#8b949e] hover:text-[#e6edf3]")
      }
    >
      <span>{label}</span>
      <span className="text-[10px] text-[#6e7681] tabular-nums">{count}</span>
      {selCount > 0 && <span className="text-[10px] text-[#238636] tabular-nums">· {selCount} selected</span>}
    </button>
  );
  return (
    <div className="flex border-b border-[#21262d] bg-[#0d1117] px-2">
      {mk("flows", "Flows", flowCount, flowSelCount)}
      {mk("templates", "Templates", tmplCount, tmplSelCount)}
    </div>
  );
}

function SelectionBar({ flowCount, tmplCount, onClear, onImport }) {
  const total = flowCount + tmplCount;
  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-[#0d1117] border-b border-[#21262d]">
      <span className="text-[12px] text-[#e6edf3] tabular-nums">
        <strong className="font-semibold">{total}</strong> selected
        <span className="text-[#6e7681] ml-1.5">
          ({flowCount} flow{flowCount === 1 ? "" : "s"}, {tmplCount} template{tmplCount === 1 ? "" : "s"})
        </span>
      </span>
      <button onClick={onClear} className="text-[11px] text-[#8b949e] hover:text-[#e6edf3] px-2 py-1">clear</button>
      <button
        onClick={onImport}
        className="ml-auto text-[12px] font-medium text-white bg-[#238636] hover:bg-[#2ea043] px-3 py-1.5 rounded-[4px] border border-[#2ea043] flex items-center gap-2"
      >
        Import {total} item{total === 1 ? "" : "s"}
        <span className="text-[10px] opacity-75">⌘↵</span>
      </button>
    </div>
  );
}

const __rootEl = document.getElementById("root");
if (__rootEl) {
  if (!window.__tobyRoot) window.__tobyRoot = ReactDOM.createRoot(__rootEl);
  window.__tobyRoot.render(<App/>);
}

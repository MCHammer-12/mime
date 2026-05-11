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

// Pure event reducer — takes a job and an unwrapped event, returns the
// next job state. Used by both the live applyEvent path (where additional
// state setters fire as side effects) AND the hydration path that rebuilds
// historical jobs from server-side event logs after a refresh. Keep this
// in sync with applyEvent — both must process events the same way.
function reduceJobEvent(j, evt) {
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
  } else if (evt.kind === "exported") {
    const parts = [`${evt.sectionCount} sections`];
    if (evt.warnings) parts.push(`${evt.warnings} warn`);
    if (evt.unsupported) parts.push(`${evt.unsupported} unsupported`);
    if (evt.aiRewrites) parts.push(`${evt.aiRewrites} AI rewrite${evt.aiRewrites === 1 ? '' : 's'}`);
    items = items.map(i => i.id === evt.id ? { ...i, name: evt.name ?? i.name, state: "running", detail: parts.join(" · ") } : i);
    if (status === "waiting_input") status = "running";
  } else if (evt.kind === "summary") {
    exportSummary = { exported: evt.exported, failed: evt.failed };
  } else if (evt.kind === "fonts_done") {
    fontsDone = evt;
  } else if (evt.kind === "imported") {
    items = items.map(i => i.id === evt.id ? { ...i, state: "imported", name: evt.name ?? i.name, detail: evt.templateId ? `→ ${evt.templateId.slice(-8)}` : i.detail } : i);
  } else if (evt.kind === "flow_imported") {
    const parts = [`${evt.createdTemplateCount} email${evt.createdTemplateCount === 1 ? '' : 's'}`];
    if (evt.blankTemplateCount) parts.push(`${evt.blankTemplateCount} blank`);
    if (evt.warningCount) parts.push(`${evt.warningCount} warn`);
    items = items.map(i => i.id === evt.id ? { ...i, state: "imported", name: evt.name ?? i.name, detail: parts.join(" · ") } : i);
  } else if (evt.kind === "campaign_imported") {
    const parts = [`${evt.createdTemplateCount} template${evt.createdTemplateCount === 1 ? '' : 's'}`];
    if (evt.variantFailures) parts.push(`${evt.variantFailures} variant fail`);
    items = items.map(i => i.id === evt.id ? { ...i, state: "imported", name: evt.name ?? i.name, detail: parts.join(" · ") } : i);
  } else if (evt.kind === "fail") {
    items = items.map(i => i.id === evt.id ? { ...i, state: "failed", name: evt.name ?? i.name, error: evt.error } : i);
  } else if (evt.kind === "warn") {
    if (evt.itemId) {
      items = items.map(i => i.id === evt.itemId
        ? { ...i, itemWarnings: [...(i.itemWarnings || []), { text: evt.text, category: classifyWarning(evt.text) }] }
        : i);
    } else {
      warnings = [...warnings, evt.text];
    }
  } else if (evt.kind === "done") {
    const totalFailed = (evt.importFailed ?? 0) + (evt.flowsFailed ?? 0) + (evt.campaignsFailed ?? 0);
    status = totalFailed > 0 ? "partial" : "complete";
    endedAt = Date.now();
    currentStep = "";
    importMethod = evt.importMethod;
    items = items.map(i => i.state === "queued" || i.state === "running" ? { ...i, state: "imported" } : i);
  }

  return { ...j, items, currentStep, warnings, infos, fatalError, fontsDone, exportSummary, status, endedAt, importMethod, pendingQid };
}
window.reduceJobEvent = reduceJobEvent;

// Hydrate a server-side JobState into the UI's job shape by replaying the
// event log against an initial item list derived from the job's
// templateIds / flowIds / campaignIds. Used to restore past jobs across
// page reloads so the operator can come back later and add feedback.
function buildJobFromServerState(srv) {
  const initialItems = [
    ...(srv.templateIds || []).map(id => ({ id, kind: "template", name: id, state: "queued" })),
    ...(srv.flowIds || []).map(id => ({ id, kind: "flow", name: id, state: "queued" })),
    ...(srv.campaignIds || []).map(id => ({ id, kind: "campaign", name: id, state: "queued" })),
  ];

  // Disabled abort + broker stubs — historical jobs aren't streamable.
  const noopAbort = { signal: { aborted: true }, abort: () => {} };
  const noopBroker = { waitFor: () => Promise.reject(new Error("historical job — broker disabled")), submit: () => {} };

  let job = {
    id: srv.id,
    shortId: (srv.id || "").slice(0, 8),
    storeId: srv.storeId,
    storeName: srv.storeName,
    merchantSlug: srv.merchantSlug,
    startedAt: srv.startedAt ? Date.parse(srv.startedAt) : null,
    endedAt: srv.completedAt ? Date.parse(srv.completedAt) : null,
    status: srv.status || "complete",
    items: initialItems,
    templateCount: (srv.templateIds || []).length,
    flowCount: (srv.flowIds || []).length,
    campaignCount: (srv.campaignIds || []).length,
    currentStep: "",
    warnings: [],
    infos: [],
    fatalError: srv.error ?? null,
    fontsDone: null,
    exportSummary: null,
    importMethod: null,
    log: [],
    abort: noopAbort,
    broker: noopBroker,
    notes: srv.notes ?? {},
    pendingQid: null,
    historical: true,
  };

  for (const env of (srv.events || [])) {
    const evt = window.unwrapJobEvent ? window.unwrapJobEvent(env) : { ...env, ...(env.payload || {}) };
    job = reduceJobEvent(job, evt);
  }

  // Normalize server status names (`completed` / `cancelled`) to the UI's
  // shape (`complete` / `canceled`) so panels that gate on terminal status
  // — most importantly the feedback / Add feedback panel — render. If the
  // event log included a `done` event, reduceJobEvent already set this to
  // `complete` or `partial`; this only fires for jobs whose log is missing
  // a done event.
  if (job.status === "completed") job.status = "complete";
  else if (job.status === "cancelled") job.status = "canceled";

  // Items that never received a terminal event stay queued — for a hydrated
  // historical job that's misleading. Mark them as failed with a synthesized
  // reason so the troubleshoot panel still surfaces them.
  job.items = job.items.map(i =>
    i.state === "queued" || i.state === "running"
      ? { ...i, state: "failed", error: i.error ?? "no terminal event recorded" }
      : i
  );

  return job;
}
window.buildJobFromServerState = buildJobFromServerState;

// Module-scope so both <App> and <MigrationScreen> reference the same
// shape. Per-section status fields are filled in by the streaming progress
// callback in fetchStoreData() — see mock-data.js.
const EMPTY_PROGRESS = {
  templates: { status: "pending" },
  campaigns: { status: "pending" },
  flows: { status: "pending" },
};
const EMPTY_DATA = {
  flows: [], templates: [], campaigns: [],
  loading: false, error: null, loaded: false,
  loadProgress: EMPTY_PROGRESS,
};

function App() {
  // ─ Stores ─
  // Persistence is in mock-stores.js — server-backed (`/api/stores`) when
  // the deploy has a Postgres URL configured, localStorage otherwise.
  // The `stores:refreshed` event fires after a server pull, so we mirror
  // it into React state. setStores() still calls saveStores() for the
  // localStorage path; the server path no-ops it (mutations go through
  // window.addStore/updateStore/deleteStore).
  const [stores, setStoresState] = useS(window.MOCK_STORES);
  const setStores = (updater) =>
    setStoresState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      window.saveStores?.(next);
      return next;
    });
  useE(() => {
    const onRefresh = (e) => setStoresState(e.detail || window.MOCK_STORES);
    window.addEventListener("stores:refreshed", onRefresh);
    return () => window.removeEventListener("stores:refreshed", onRefresh);
  }, []);

  const [view, setView] = useS({ screen: "dashboard", storeId: null });
  const [showAddStore, setShowAddStore] = useS(false);

  // ─ Admin identity (Austin / Michael) ─
  // Loaded once at startup from /api/admin/identity. `null` until the
  // operator picks via the first-visit modal; then sticks via cookie so
  // subsequent loads skip the modal.
  const [adminUser, setAdminUser] = useS(null);
  const [adminUserLoaded, setAdminUserLoaded] = useS(false);
  // List of admin slot names currently claimed by some browser. The
  // identity modal disables taken options unless they match adminUser
  // (in which case picking re-affirms the existing claim).
  const [claimedUsers, setClaimedUsers] = useS([]);
  const refreshIdentity = useC(async () => {
    try {
      const r = await fetch("/api/admin/identity");
      if (!r.ok) { setAdminUserLoaded(true); return; }
      const j = await r.json();
      setAdminUser(j.user || null);
      setClaimedUsers(Array.isArray(j.claimedUsers) ? j.claimedUsers : []);
      setAdminUserLoaded(true);
    } catch (_) {
      setAdminUserLoaded(true);
    }
  }, []);
  useE(() => { refreshIdentity(); }, [refreshIdentity]);
  const pickAdminUser = useC(async (user) => {
    try {
      const r = await fetch("/api/admin/identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user }),
      });
      if (r.status === 403) {
        // Slot taken by someone else — refresh the claim list so the modal
        // greys out the option and surfaces the conflict.
        await refreshIdentity();
        return false;
      }
      if (!r.ok) return false;
      const j = await r.json();
      setAdminUser(j.user || null);
      // Re-pull claimedUsers so other slots' state stays accurate.
      refreshIdentity();
      return true;
    } catch (_) {
      return false;
    }
  }, [refreshIdentity]);
  const switchAdminUser = useC(async () => {
    try {
      await fetch("/api/admin/identity", { method: "DELETE" });
    } catch (_) { /* best-effort */ }
    setAdminUser(null);
  }, []);
  // null = closed; { id, ... } = open with a specific store loaded.
  // Triggered from the dashboard's per-card edit pencil. Lets the user
  // rotate an expired JWT or update a Klaviyo key without re-creating
  // the store record.
  const [editingStore, setEditingStore] = useS(null);

  // ─ Per-store data catalogs, fetched on demand ─
  // Each entry: {
  //   flows, templates, campaigns,
  //   loading, error, loaded,
  //   loadProgress: {
  //     templates: { status, count?, error? },
  //     campaigns: { status, count?, error? },
  //     flows:     { status, total?, scanned?, currentName?, count?, error? },
  //   },
  // }
  // loadProgress is updated live as the per-section streaming events
  // arrive from fetchStoreData() — see mock-data.js for the event shape.
  const [storeDataMap, setStoreDataMap] = useS({});
  const data = view.storeId
    ? (storeDataMap[view.storeId] || EMPTY_DATA)
    : EMPTY_DATA;

  // Hydrated-store cache: when stores come from the server, the list
  // entries have masked keys only. We pull the full record (with
  // klaviyoKey + redoToken) the first time it's needed for a migration.
  // Mutations still go through window.updateStore — this map just
  // remembers what we've fetched this session.
  const [hydratedStores, setHydratedStores] = useS({});

  const getHydratedStore = useC(async (storeId) => {
    if (hydratedStores[storeId]) return hydratedStores[storeId];
    const fromList = stores.find((s) => s.id === storeId);
    if (fromList && fromList.klaviyoKey) {
      // localStorage backend already has unmasked keys in the list.
      setHydratedStores((h) => ({ ...h, [storeId]: fromList }));
      return fromList;
    }
    if (typeof window.fetchStoreById !== "function") {
      return fromList ?? null;
    }
    try {
      const full = await window.fetchStoreById(storeId);
      setHydratedStores((h) => ({ ...h, [storeId]: full }));
      return full;
    } catch (e) {
      console.warn("getHydratedStore failed", storeId, e);
      return fromList ?? null;
    }
  }, [stores, hydratedStores]);

  // Fetch flows + templates when the user opens a store's migration view.
  useE(() => {
    if (view.screen !== "migration" || !view.storeId) return;
    const listed = stores.find((s) => s.id === view.storeId);
    if (!listed) return;
    if (storeDataMap[view.storeId]?.loaded) return; // already fetched

    const sid = view.storeId;
    setStoreDataMap((m) => ({
      ...m,
      [sid]: { ...EMPTY_DATA, loading: true, loadProgress: EMPTY_PROGRESS },
    }));

    // Per-section live progress callback. Merges into loadProgress so
    // the loading panel can render the current state of each section.
    const onProgress = (ev) => {
      setStoreDataMap((m) => {
        const prev = m[sid] || EMPTY_DATA;
        const prevProg = prev.loadProgress || EMPTY_PROGRESS;
        const sectionPatch = { ...ev };
        delete sectionPatch.section;
        return {
          ...m,
          [sid]: {
            ...prev,
            loadProgress: {
              ...prevProg,
              [ev.section]: { ...(prevProg[ev.section] || {}), ...sectionPatch },
            },
          },
        };
      });
    };

    getHydratedStore(sid)
      .then((store) => {
        if (!store?.klaviyoKey) {
          throw new Error(
            "store has no klaviyoKey — open the credentials editor and paste a key first",
          );
        }
        return window.fetchStoreData(store, onProgress);
      })
      .then((res) => {
        setStoreDataMap((m) => ({
          ...m,
          [sid]: {
            ...(m[sid] || EMPTY_DATA),
            flows: res.flows ?? [],
            flowsTotal: res.flowsTotal ?? (res.flows?.length ?? 0),
            templates: res.templates ?? [],
            campaigns: res.campaigns ?? [],
            loading: false,
            error: null,
            loaded: true,
          },
        }));
      })
      .catch((e) => {
        setStoreDataMap((m) => ({
          ...m,
          [sid]: {
            ...(m[sid] || EMPTY_DATA),
            loading: false,
            error: e?.message ?? String(e),
            loaded: true,
          },
        }));
      });
  }, [view.screen, view.storeId, stores]);

  // ─ Per-store session imported (prior imports + current session) ─
  // Keyed by storeId for correct scope. Two separate sets here on purpose:
  //
  //   priorImports     — snapshot of what was imported BEFORE this session
  //                       opened the store. Hydrated from localStorage on
  //                       first open and then NEVER mutated during the
  //                       session. Drives the "Hide already imported"
  //                       filter so flows currently being imported do
  //                       NOT vanish from the catalog mid-import.
  //
  //   sessionImports   — running union of priorImports + everything that
  //                       has finished importing in THIS session. Drives
  //                       the per-row "imported" badge so rows light up
  //                       green as soon as the server emits flow_imported.
  const [priorImports, setPriorImports] = useS({});     // {storeId: {flows: Set, tmpls: Set, campaigns: Set}}
  const [sessionImports, setSessionImports] = useS({}); // {storeId: {flows: Set, tmpls: Set, campaigns: Set}}
  const [lastResult, setLastResult] = useS({});         // {storeId: Map<id, "imported"|"failed">}
  const [inProgress, setInProgress] = useS({});         // {storeId: Set<id>}

  // ─ Per-store selection + filters ─
  const [perStore, setPerStore] = useS({}); // {storeId: {tab, flowFilter, tmplFilter, flowStatus, hideFlow, hideTmpl, selectedFlowIds, selectedTmplIds}}

  // ─ Jobs (flat, app-level — each has storeId) ─
  const [jobs, setJobs] = useS([]);
  const [panelCollapsed, setPanelCollapsed] = useS(false);
  const [logJobId, setLogJobId] = useS(null);
  const [warningsView, setWarningsView] = useS(null); // {jobId, itemId}

  // ─ Hours saved tally — running total across all imports, shown in header.
  // Server is the source of truth; we refetch on mount and after each
  // job completion. Hours = ceil(emails * 20min / 60).
  const [hoursSaved, setHoursSaved] = useS(null);

  const refreshMetrics = useC(async () => {
    try {
      const r = await fetch("/api/admin/metrics");
      if (!r.ok) return;
      const m = await r.json();
      if (typeof m.totalHours === "number") setHoursSaved(m.totalHours);
    } catch (_) { /* best-effort */ }
  }, []);

  useE(() => { refreshMetrics(); }, [refreshMetrics]);

  // ─ Pending needs_input question (single modal at a time) ─
  const [pendingInput, setPendingInput] = useS(null); // {jobId, qid, itemId, itemName, question, options, broker}

  const getStoreState = (storeId) => perStore[storeId] || {
    tab: "flows",
    flowFilter: "", tmplFilter: "", campaignFilter: "",
    flowStatus: "live",
    campaignStatus: "all",
    hideFlow: true, hideTmpl: true, hideCampaign: true,
    selectedFlowIds: new Set(), selectedTmplIds: new Set(), selectedCampaignIds: new Set(),
  };
  const updateStoreState = (storeId, patch) => {
    setPerStore(ps => ({ ...ps, [storeId]: { ...getStoreState(storeId), ...(typeof patch === "function" ? patch(getStoreState(storeId)) : patch) } }));
  };

  const getStoreImports = (storeId) => sessionImports[storeId] || {
    flows: new Set([...window.PRIOR_IMPORTED_FLOW_IDS]),
    tmpls: new Set([...window.PRIOR_IMPORTED_TEMPLATE_IDS]),
    campaigns: new Set([...(window.PRIOR_IMPORTED_CAMPAIGN_IDS ?? [])]),
  };
  // Read-only snapshot of imports done before this session. Hide-filters
  // use this so newly-imported items don't disappear from the catalog
  // during an active import.
  const getStorePriorImports = (storeId) => priorImports[storeId] || {
    flows: new Set(),
    tmpls: new Set(),
    campaigns: new Set(),
  };

  // ─ Hydrate past jobs from the server on first mount ─
  // Without this, every page refresh wipes the jobs panel — the operator
  // can't come back later to add feedback on items that imported but look
  // wrong in Redo. Fetch the job index, then pull each job's full event log
  // and replay it through the same reducer the live applyEvent path uses.
  // Skip jobs we already have in memory (running session) to avoid clobbering
  // in-progress state.
  useE(() => {
    let cancelled = false;
    (async () => {
      try {
        const idxRes = await fetch("/api/jobs");
        if (!idxRes.ok) return;
        const { jobs: index = [] } = await idxRes.json();
        if (cancelled || index.length === 0) return;

        // Hydrate only terminal jobs — for running / awaiting_input ones the
        // server still has the live stream open, so we'd need to reconnect
        // (not just replay history). Out of scope for now.
        // Status names are the server's (`completed` / `failed` / `cancelled`),
        // not the UI's (`complete` / `partial` / `canceled`); buildJobFromServerState
        // normalizes them to UI shape after replaying events.
        const TERMINAL = new Set(["completed", "failed", "cancelled"]);
        const existingIds = new Set(jobs.map(j => j.id));
        const toFetch = index.filter(j => !existingIds.has(j.id) && TERMINAL.has(j.status));
        if (toFetch.length === 0) return;

        const settled = await Promise.allSettled(
          toFetch.map(meta => fetch(`/api/jobs/${encodeURIComponent(meta.id)}`).then(r => r.ok ? r.json() : null))
        );
        if (cancelled) return;

        const built = [];
        for (const s of settled) {
          if (s.status !== "fulfilled" || !s.value) continue;
          try {
            built.push(buildJobFromServerState(s.value));
          } catch (e) {
            // Skip individual job rebuild failures — rest of the list still hydrates.
            console.warn("hydrate job failed:", e?.message ?? e);
          }
        }
        if (built.length === 0) return;

        // Insert sorted oldest-first so the live `setJobs(js => [job, ...js])`
        // pattern keeps the most-recent jobs at the top.
        built.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
        setJobs(prev => {
          const have = new Set(prev.map(j => j.id));
          const merged = [...prev];
          for (const j of built) if (!have.has(j.id)) merged.push(j);
          // Re-sort newest first (matches startImport's prepend pattern)
          merged.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
          return merged;
        });
      } catch (e) {
        // Hydration is best-effort — failures shouldn't break the app
        console.warn("job hydration failed:", e?.message ?? e);
      }
    })();
    return () => { cancelled = true; };
  }, []); // run once on mount

  // ─ Hydrate prior imports from localStorage when a store is opened ─
  // Without this, the "already imported" badges + filters reset to empty
  // every time the page reloads, even though we successfully imported
  // those items in a previous session. Per-store, scoped by storeId.
  // Skips if sessionImports already has an entry for this store (we
  // don't want to clobber in-progress session updates with stale disk
  // state when the user navigates away and back).
  useE(() => {
    if (view.screen !== "migration" || !view.storeId) return;
    if (sessionImports[view.storeId]) return;
    const prior = window.loadPriorImports?.(view.storeId);
    if (!prior) return;
    // Snapshot for the hide-filter — must NOT update during the session.
    setPriorImports((pi) => ({
      ...pi,
      [view.storeId]: {
        flows: new Set(prior.flows),
        tmpls: new Set(prior.tmpls),
        campaigns: new Set(prior.campaigns),
      },
    }));
    // Live combined set — starts equal to priors, grows during session.
    setSessionImports((si) => ({ ...si, [view.storeId]: prior }));
    // Also seed lastResult so already-imported items render the green
    // "imported" pill on first paint, not just the "already imported"
    // hide-filter toggle.
    setLastResult((lr) => {
      const existing = lr[view.storeId] ?? new Map();
      const merged = new Map(existing);
      for (const id of prior.flows) if (!merged.has(id)) merged.set(id, "imported");
      for (const id of prior.tmpls) if (!merged.has(id)) merged.set(id, "imported");
      for (const id of prior.campaigns) if (!merged.has(id)) merged.set(id, "imported");
      return { ...lr, [view.storeId]: merged };
    });
  }, [view.screen, view.storeId]);

  // ─ Add store ─
  // Saves the store via window.addStore (server-backed when DB is on,
  // localStorage-fallback otherwise) and immediately opens its migration
  // screen. The hydrated cache gets seeded with the just-created record so
  // the migration view doesn't make a second round-trip for keys we just
  // sent.
  const addStore = async (data) => {
    try {
      const newStore = await window.addStore({
        name: data.name,
        merchantSlug: data.merchantSlug ?? data.name,
        klaviyoKey: data.klaviyoKey,
        redoToken: data.redoToken,
        decodedStoreId: data.decodedStoreId,
        redoServerBase: data.redoServerBase ?? null,
      });
      setHydratedStores((h) => ({ ...h, [newStore.id]: newStore }));
      // Refresh-driven setStores keeps server backend in sync; for
      // localStorage we still mirror into React state explicitly.
      setStoresState((prev) =>
        prev.some((s) => s.id === newStore.id) ? prev : [...prev, newStore],
      );
      setShowAddStore(false);
      setView({ screen: "migration", storeId: newStore.id });
    } catch (e) {
      window.alert(`Failed to save store: ${e?.message ?? e}`);
    }
  };

  // ─ Update store ─ (e.g. rotating an expired JWT)
  const updateStoreCreds = async (storeId, patch) => {
    try {
      const updated = await window.updateStore(storeId, patch);
      if (!updated) return;
      setHydratedStores((h) => ({ ...h, [storeId]: updated }));
      setStoresState((prev) =>
        prev.map((s) => (s.id === storeId ? { ...s, ...updated } : s)),
      );
    } catch (e) {
      window.alert(`Failed to update store: ${e?.message ?? e}`);
    }
  };

  // ─ Delete store ─
  // Confirms then removes the store from the list. Related per-store caches
  // (storeDataMap, perStore, sessionImports, lastResult, inProgress) are
  // left as orphan entries — they're keyed by storeId and garbage-collected
  // on the next browser-storage clear. Jobs stay in the jobs panel so the
  // user can still open their logs.
  const deleteStore = async (storeId) => {
    const store = stores.find(s => s.id === storeId);
    if (!store) return;
    const jobsForStore = jobs.filter(j => j.storeId === storeId);
    const running = jobsForStore.filter(j => j.status === "running" || j.status === "waiting_input").length;
    const msg = running > 0
      ? `Delete "${store.name}"?\n\n${running} job${running === 1 ? "" : "s"} still running — they'll keep running on the server but disappear from the dashboard.`
      : `Delete "${store.name}"?\n\nThe store card will be removed from the dashboard. Prior imports in Redo are unaffected.`;
    if (!window.confirm(msg)) return;
    try {
      await window.deleteStore(storeId);
    } catch (e) {
      window.alert(`Failed to delete store: ${e?.message ?? e}`);
      return;
    }
    setStoresState((prev) => prev.filter((x) => x.id !== storeId));
    setHydratedStores((h) => { const { [storeId]: _drop, ...rest } = h; return rest; });
    setStoreDataMap(m => {
      const { [storeId]: _drop, ...rest } = m;
      return rest;
    });
  };

  // ─ Navigation ─
  const openStore = (storeId) => setView({ screen: "migration", storeId });
  const goDashboard = () => setView({ screen: "dashboard", storeId: null });

  // ─ Import ─
  const startImport = useC(async (storeId) => {
    // Server-backed stores carry only masked keys in the listing — pull
    // the full record before kicking off the import.
    const store = await getHydratedStore(storeId);
    if (!store) return;
    if (!store.klaviyoKey) {
      window.alert(
        "This store has no Klaviyo key on record. Open the credentials editor to paste one before starting the import.",
      );
      return;
    }
    const ss = getStoreState(storeId);
    const totalSel = ss.selectedFlowIds.size + ss.selectedTmplIds.size + ss.selectedCampaignIds.size;
    if (totalSel === 0) return;

    // Temporary client id, replaced by the server-assigned id as soon as
    // the stream's first `_jobCreated` event arrives. Using `let` so we
    // can update it in place — applyEvent calls below capture this binding.
    let jobId = `j_${Date.now()}`;
    const jobsInStore = jobs.filter(j => j.storeId === storeId).length;
    const shortId = `#${String(jobsInStore + 1).padStart(3, "0")}`;
    const abort = new AbortController();
    const broker = window.makeAnswerBroker();

    const flowIds = [...ss.selectedFlowIds];
    const templateIds = [...ss.selectedTmplIds];
    const campaignIds = [...ss.selectedCampaignIds];

    const items = [
      ...templateIds.map(id => {
        const t = data.templates.find(x => x.id === id);
        return { id, name: t?.name || id, kind: "template", state: "queued" };
      }),
      ...flowIds.map(id => {
        const f = data.flows.find(x => x.flowId === id);
        return { id, name: f?.flowName || id, kind: "flow", state: "queued" };
      }),
      ...campaignIds.map(id => {
        const c = data.campaigns.find(x => x.campaignId === id);
        return { id, name: c?.campaignName || id, kind: "campaign", state: "queued" };
      }),
    ];

    const job = {
      id: jobId, shortId,
      storeId,
      storeName: store.name,
      startedAt: Date.now(), endedAt: null,
      status: "running",
      items,
      templateCount: templateIds.length, flowCount: flowIds.length, campaignCount: campaignIds.length,
      currentStep: "", warnings: [], infos: [],
      fatalError: null, fontsDone: null, exportSummary: null, importMethod: null,
      log: [], abort, broker,
    };

    setJobs(js => [job, ...js]);
    setInProgress(ip => ({ ...ip, [storeId]: new Set([...(ip[storeId] || []), ...items.map(i => i.id)]) }));
    updateStoreState(storeId, { selectedFlowIds: new Set(), selectedTmplIds: new Set(), selectedCampaignIds: new Set() });

    // Update store lastImportedAt
    setStores(ss => ss.map(s => s.id === storeId ? { ...s, lastImportedAt: Date.now() } : s));

    (async () => {
      try {
        const stream = window.mockRunStream({
          templateIds, flowIds, campaignIds,
          flows: data.flows, templates: data.templates, campaigns: data.campaigns,
          signal: abort.signal,
          store,                           // carries klaviyoKey + redoToken + decodedStoreId
          storeName: store.name,
          merchantSlug: store.merchantSlug || store.name,
          answerBroker: broker,
        });
        for await (const evt of stream) {
          if (evt.kind === "_jobCreated" && evt.serverJobId) {
            // Snapshot the old id into a const BEFORE queueing setJobs.
            // The setJobs callback closes over `oldId` by value; if it
            // closed over `jobId` directly, the synchronous `jobId = newId`
            // below would mutate the variable before React invoked the
            // callback, causing `j.id === jobId` to compare newId to newId
            // and miss the existing job. Subsequent applyEvent calls would
            // then fail to find the job by its new id and the UI would
            // freeze at its initial state.
            const oldId = jobId;
            const newId = evt.serverJobId;
            setJobs(js => js.map(j => j.id === oldId ? { ...j, id: newId } : j));
            jobId = newId;
            continue;
          }
          applyEvent(jobId, evt);
        }
      } catch (e) {
        applyEvent(jobId, { kind: "error", text: e?.message ?? String(e) });
      }
    })();
  }, [stores, perStore, jobs, data, getHydratedStore]);

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
      let emailsImported = j.emailsImported || 0;

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
          hideApplyAll: evt.hideApplyAll,
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
        emailsImported += 1;
        items = items.map(i => i.id === evt.id ? { ...i, state: "imported", detail: `→ ${evt.templateId.slice(-8)}` } : i);
        setSessionImports(si => {
          const cur = si[j.storeId] || { flows: new Set([...window.PRIOR_IMPORTED_FLOW_IDS]), tmpls: new Set([...window.PRIOR_IMPORTED_TEMPLATE_IDS]), campaigns: new Set([...(window.PRIOR_IMPORTED_CAMPAIGN_IDS ?? [])]) };
          const nextStore = { ...cur, tmpls: new Set([...cur.tmpls, evt.id]) };
          window.savePriorImports?.(j.storeId, nextStore);
          return { ...si, [j.storeId]: nextStore };
        });
        setLastResult(lr => ({ ...lr, [j.storeId]: new Map([...(lr[j.storeId] || new Map())]).set(evt.id, "imported") }));
        setInProgress(ip => { const n = new Set(ip[j.storeId] || []); n.delete(evt.id); return { ...ip, [j.storeId]: n }; });
      } else if (evt.kind === "flow_imported") {
        emailsImported += (evt.createdTemplateCount ?? 0) + (evt.blankTemplateCount ?? 0);
        const parts = [`${evt.createdTemplateCount} email${evt.createdTemplateCount === 1 ? '' : 's'}`];
        if (evt.blankTemplateCount) parts.push(`${evt.blankTemplateCount} blank`);
        if (evt.warningCount) parts.push(`${evt.warningCount} warn`);
        items = items.map(i => i.id === evt.id ? { ...i, state: "imported", detail: parts.join(" · ") } : i);
        setSessionImports(si => {
          const cur = si[j.storeId] || { flows: new Set([...window.PRIOR_IMPORTED_FLOW_IDS]), tmpls: new Set([...window.PRIOR_IMPORTED_TEMPLATE_IDS]), campaigns: new Set([...(window.PRIOR_IMPORTED_CAMPAIGN_IDS ?? [])]) };
          const nextStore = { ...cur, flows: new Set([...cur.flows, evt.id]) };
          window.savePriorImports?.(j.storeId, nextStore);
          return { ...si, [j.storeId]: nextStore };
        });
        setLastResult(lr => ({ ...lr, [j.storeId]: new Map([...(lr[j.storeId] || new Map())]).set(evt.id, "imported") }));
        setInProgress(ip => { const n = new Set(ip[j.storeId] || []); n.delete(evt.id); return { ...ip, [j.storeId]: n }; });
      } else if (evt.kind === "campaign_imported") {
        const parts = [`${evt.createdTemplateCount} template${evt.createdTemplateCount === 1 ? '' : 's'}`];
        if (evt.variantFailures) parts.push(`${evt.variantFailures} variant fail`);
        items = items.map(i => i.id === evt.id ? { ...i, state: "imported", detail: parts.join(" · ") } : i);
        setSessionImports(si => {
          const cur = si[j.storeId] || { flows: new Set([...window.PRIOR_IMPORTED_FLOW_IDS]), tmpls: new Set([...window.PRIOR_IMPORTED_TEMPLATE_IDS]), campaigns: new Set([...(window.PRIOR_IMPORTED_CAMPAIGN_IDS ?? [])]) };
          const nextStore = { ...cur, campaigns: new Set([...cur.campaigns, evt.id]) };
          window.savePriorImports?.(j.storeId, nextStore);
          return { ...si, [j.storeId]: nextStore };
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
        const totalFailed = (evt.importFailed ?? 0) + (evt.flowsFailed ?? 0) + (evt.campaignsFailed ?? 0);
        status = totalFailed > 0 ? "partial" : "complete";
        endedAt = Date.now();
        currentStep = "";
        importMethod = evt.importMethod;
        items = items.map(i => i.state === "queued" || i.state === "running" ? { ...i, state: "imported" } : i);
        // Refresh the running header tally on completion. Post-render via
        // setTimeout so we don't mutate sibling state from inside the
        // reducer.
        if (j.status !== status && (status === "complete" || status === "partial")) {
          setTimeout(() => refreshMetrics(), 0);
        }
      }

      return { ...j, items, currentStep, warnings, infos, fatalError, fontsDone, exportSummary, status, endedAt, log, importMethod, pendingQid, emailsImported };
    }));
  }, [refreshMetrics]);

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
    // Pull the full record (with klaviyoKey) before re-running the import —
    // listed stores only carry masked keys when DB is enabled.
    const store = storeId ? await getHydratedStore(storeId) : null;
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
  }, [jobs, stores, data, applyEvent, getHydratedStore]);

  const dismissJob = useC((jobId) => {
    setJobs(js => js.filter(j => j.id !== jobId));
  }, []);
  // Persist a note to the server. Keeps a local mirror on the job record so
  // re-renders see it without a refetch. Failure is silent — the user keeps
  // their local copy and can retry on next edit.
  const saveJobNote = useC(async (jobId, itemId, note) => {
    setJobs(js => js.map(j => j.id !== jobId ? j : ({
      ...j,
      notes: { ...(j.notes || {}), [itemId]: note },
    })));
    try {
      await fetch(`/api/jobs/${jobId}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId, note }),
      });
    } catch (e) {
      console.warn("save note failed:", e);
    }
  }, []);
  // Trigger a zip download from the bundle endpoint. Posts the selected
  // item ids/types and saves the resulting blob as a download.
  const exportJobBundle = useC(async (jobId, items) => {
    const r = await fetch(`/api/jobs/${jobId}/bundle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items }),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => "");
      alert(`Bundle failed: ${r.status} ${err}`);
      return;
    }
    const blob = await r.blob();
    const cd = r.headers.get("content-disposition") || "";
    const m = cd.match(/filename="([^"]+)"/);
    const filename = m ? m[1] : `troubleshoot-${jobId}.zip`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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

  // ─ Env (prod by default; only dev when /api/env says so). Dev mode
  //   shows a soft orange glow around the screen so it's obvious we're
  //   not pointed at production.
  const [hosted, setHosted] = useS(() => {
    // Seed from mockEnv if already set (survives re-renders); otherwise prod.
    if (window.mockEnv && typeof window.mockEnv.hostedDeploy === "boolean") {
      return window.mockEnv.hostedDeploy;
    }
    window.mockEnv = { ...(window.mockEnv || {}), hostedDeploy: true };
    return true;
  });
  useE(() => {
    let cancelled = false;
    fetch("/api/env")
      .then(r => r.ok ? r.json() : null)
      .then(env => {
        if (cancelled || !env) return;
        // Only downgrade to dev if the server explicitly says so.
        if (env.hostedDeploy === false) {
          window.mockEnv = { ...(window.mockEnv || {}), hostedDeploy: false };
          setHosted(false);
        }
      })
      .catch(() => { /* default stays prod */ });
    return () => { cancelled = true; };
  }, []);

  // ─ Render ─
  const activeStore = view.storeId ? stores.find(s => s.id === view.storeId) : null;

  return (
    <div
      className="h-screen w-screen flex flex-col bg-[#0d1117] text-[#e6edf3] font-sans relative"
      style={hosted ? undefined : {
        boxShadow: "inset 0 0 0 2px rgba(255, 68, 5, 0.45), inset 0 0 60px rgba(255, 68, 5, 0.18)",
      }}
    >
      <TopBar
        view={view}
        store={activeStore}
        hosted={hosted}
        hoursSaved={hoursSaved}
        adminUser={adminUser}
        onSwitchAdminUser={switchAdminUser}
        onToggleHosted={() => {
          const next = !hosted;
          window.mockEnv = { ...(window.mockEnv || {}), hostedDeploy: next };
          setHosted(next);
        }}
        onGoDashboard={goDashboard}
      />
      <div className="flex flex-1 overflow-hidden">
        {view.screen === "dashboard" ? (
          <Dashboard
            stores={stores}
            jobs={jobs}
            currentUser={adminUser}
            onOpenStore={openStore}
            onAddStore={() => setShowAddStore(true)}
            onDeleteStore={deleteStore}
            onEditStore={(storeId) => {
              const s = stores.find((x) => x.id === storeId);
              if (s) setEditingStore(s);
            }}
          />
        ) : (
          <MigrationScreen
            store={activeStore}
            data={data}
            state={getStoreState(activeStore.id)}
            updateState={(patch) => updateStoreState(activeStore.id, patch)}
            imports={getStoreImports(activeStore.id)}
            priorImports={getStorePriorImports(activeStore.id)}
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
          onSaveNote={saveJobNote}
          onExportBundle={exportJobBundle}
        />
      </div>

      {adminUserLoaded && !adminUser && (
        <IdentityModal
          onPick={pickAdminUser}
          claimedUsers={claimedUsers}
        />
      )}

      {showAddStore && (
        <SetupModal onSave={addStore} onClose={() => setShowAddStore(false)} />
      )}
      {editingStore && (
        <SetupModal
          initialStore={editingStore}
          onClose={() => setEditingStore(null)}
          onSave={async (data) => {
            const patch = {
              name: data.name,
              klaviyoKey: data.klaviyoKey,
              decodedStoreId: data.decodedStoreId,
              redoServerBase: data.redoServerBase,
            };
            // Empty redoToken in edit mode means "keep existing", so only
            // include it when the user actually pasted a new value.
            if (typeof data.redoToken === "string" && data.redoToken.length > 0) {
              patch.redoToken = data.redoToken;
            }
            await updateStoreCreds(editingStore.id, patch);
            setEditingStore(null);
          }}
        />
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

// First-visit modal asking which admin (Austin / Michael) is using the
// dashboard. Choice persists via the admin_claim cookie (HttpOnly,
// matched against admin_claims.claim_token server-side). Once a slot
// is claimed by another browser, the corresponding option is disabled
// for everyone else — the lockdown ensures only the first Austin and
// the first Michael can ever access the dashboard from then on.
function IdentityModal({ onPick, claimedUsers }) {
  const [picking, setPicking] = useS(null);
  const [error, setError] = useS(null);
  const choose = async (name) => {
    setPicking(name);
    setError(null);
    const ok = await onPick(name);
    if (!ok) {
      setPicking(null);
      setError(`${name} is already claimed by another browser.`);
    }
  };
  const allClaimed =
    claimedUsers.includes("Austin") && claimedUsers.includes("Michael");
  return (
    <div className="fixed inset-0 z-[55] bg-[#010409cc] backdrop-blur-sm flex items-center justify-center px-4">
      <div className="w-full max-w-[400px] bg-[#0d1117] border border-[#30363d] rounded-[6px] shadow-2xl px-6 py-5">
        <h2 className="font-serif text-[22px] leading-none text-[#e6edf3] mb-1">Who's using this?</h2>
        <p className="text-[12px] text-[#8b949e] mb-5 leading-relaxed">
          {allClaimed
            ? "Both slots are claimed. If one of them is yours, sign in from the original browser. Otherwise this dashboard is locked."
            : "Pick once. Notes you save and stores you create get attributed to your name. Each name can only be claimed by one browser."}
        </p>
        <div className="flex gap-2">
          {["Austin", "Michael"].map((name) => {
            const taken = claimedUsers.includes(name);
            const disabled = taken || picking !== null;
            return (
              <button
                key={name}
                onClick={() => choose(name)}
                disabled={disabled}
                title={taken ? `${name} is already claimed` : undefined}
                className="flex-1 px-4 py-3 rounded-[6px] border border-[#30363d] hover:border-[#388bfd] text-[#e6edf3] text-[14px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-[#30363d]"
              >
                {picking === name ? "…" : name}
                {taken && (
                  <span className="block text-[10px] text-[#6e7681] font-normal mt-0.5">
                    claimed
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {error && (
          <p className="text-[11px] text-[#f85149] mt-4">{error}</p>
        )}
      </div>
    </div>
  );
}

// Per-assistant assist URLs. Update here when new assistants are added.
const ASSISTANTS = ["Dennis", "Toby"];

// Header widget: "View as Dennis | Toby" links. Opens the assist view in
// a new tab with ?as=<name>&preview=1 so writes are disabled — Michael
// can preview without polluting attribution.
function ViewAsLinks() {
  return (
    <span className="flex items-center gap-1.5 px-2 py-0.5 border border-[#30363d] rounded-[3px]">
      <span className="text-[#6e7681]">View as</span>
      {ASSISTANTS.map((name, i) => (
        <React.Fragment key={name}>
          {i > 0 && <span className="text-[#30363d]">·</span>}
          <a
            href={`/?as=${encodeURIComponent(name)}&preview=1`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#388bfd] hover:text-[#58a6ff]"
          >
            {name}
          </a>
        </React.Fragment>
      ))}
    </span>
  );
}

function TopBar({ view, store, hosted, hoursSaved, adminUser, onSwitchAdminUser, onToggleHosted, onGoDashboard }) {
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
      {!hosted && (
        <span className="text-[10px] uppercase tracking-wider text-[#FF4405] font-semibold px-2 py-0.5 border border-[#FF4405]/60 rounded-[3px] bg-[#FF440510]">
          DEV
        </span>
      )}
      <div className="flex items-center gap-2 text-[12px] ml-3">
        <button
          onClick={onGoDashboard}
          className={view.screen === "dashboard" ? "text-[#e6edf3]" : "text-[#8b949e] hover:text-[#e6edf3]"}
        >Dashboard</button>
        <span className="text-[#484f58]">·</span>
        <a
          // Open assist signed in AS the current admin — writes (notes,
          // done checkmarks) attribute to Michael/Austin rather than
          // requiring read-only preview mode.
          href={adminUser ? `/?as=${encodeURIComponent(adminUser)}` : "/"}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#8b949e] hover:text-[#e6edf3]"
        >Assist ↗</a>
        {view.screen === "migration" && store && (
          <>
            <span className="text-[#484f58]">/</span>
            <span className="font-serif text-[16px] leading-none text-[#e6edf3]">{store.name}</span>
          </>
        )}
      </div>
      <div className="ml-auto text-[11px] text-[#6e7681] flex items-center gap-3">
        {adminUser && (
          <span className="px-2 py-0.5 border border-[#30363d] rounded-[3px] flex items-center gap-1.5">
            <span className="text-[#e6edf3]">{adminUser}</span>
            <button
              onClick={onSwitchAdminUser}
              title="Switch user"
              className="text-[#6e7681] hover:text-[#e6edf3]"
            >
              <Icon.x width="10" height="10"/>
            </button>
          </span>
        )}
        <ViewAsLinks />
        {typeof hoursSaved === "number" && (
          <span className="px-2 py-0.5 border border-[#30363d] rounded-[3px] tabular-nums">
            Hours saved: <span className="text-[#FF4405] font-semibold">{hoursSaved}</span>
          </span>
        )}
        <button
          onClick={onToggleHosted}
          title="Toggle env between prod and dev (visual only)"
          className="flex items-center gap-1.5 px-1.5 py-0.5 border border-[#30363d] rounded-[3px] hover:border-[#484f58] hover:text-[#e6edf3]"
        >
          <span>env:</span>
          <span className={hosted ? "text-[#3fb950]" : "text-[#FF4405]"}>
            {hosted ? "prod" : "dev"}
          </span>
        </button>
        <span>AI: <span className="text-[#3fb950]">on</span></span>
      </div>
    </div>
  );
}

function MigrationScreen({ store, data, state, updateState, imports, priorImports, lastResult, inProgress, onImport }) {
  // The hide-already-imported filter intentionally uses `priorImports`
  // (snapshot at store-open) rather than the live `imports` set. If we
  // used `imports`, every flow would vanish from the catalog the moment
  // it finished importing — which made an in-progress run look like
  // "no flows match these filters" once enough rows had completed.
  const hideSet = priorImports || { flows: new Set(), tmpls: new Set(), campaigns: new Set() };

  const visibleFlows = useM(() => data.flows.filter(f => {
    if (state.flowStatus !== "all" && f.flowStatus !== state.flowStatus) return false;
    if (state.flowFilter && !f.flowName.toLowerCase().includes(state.flowFilter.toLowerCase())) return false;
    if (state.hideFlow && hideSet.flows.has(f.flowId)) return false;
    return true;
  }), [data.flows, state.flowStatus, state.flowFilter, state.hideFlow, hideSet.flows]);

  const visibleTmpls = useM(() => data.templates.filter(t => {
    if (state.tmplFilter && !t.name.toLowerCase().includes(state.tmplFilter.toLowerCase())) return false;
    if (state.hideTmpl && hideSet.tmpls.has(t.id)) return false;
    return true;
  }), [data.templates, state.tmplFilter, state.hideTmpl, hideSet.tmpls]);

  const visibleCampaigns = useM(() => (data.campaigns ?? []).filter(c => {
    if (state.campaignStatus !== "all" && state.campaignStatus !== c.status) return false;
    if (state.campaignFilter && !c.campaignName.toLowerCase().includes(state.campaignFilter.toLowerCase())) return false;
    if (state.hideCampaign && hideSet.campaigns.has(c.campaignId)) return false;
    return true;
  }), [data.campaigns, state.campaignStatus, state.campaignFilter, state.hideCampaign, hideSet.campaigns]);

  // "X hidden" indicator must reflect what the filter actually hides,
  // so it counts against the same priorImports snapshot.
  const flowsAlreadyCount = useM(() => data.flows.filter(f => hideSet.flows.has(f.flowId)).length, [data.flows, hideSet.flows]);
  const tmplsAlreadyCount = useM(() => data.templates.filter(t => hideSet.tmpls.has(t.id)).length, [data.templates, hideSet.tmpls]);
  const campaignsAlreadyCount = useM(() => (data.campaigns ?? []).filter(c => hideSet.campaigns.has(c.campaignId)).length, [data.campaigns, hideSet.campaigns]);

  // Annotate campaigns whose template IDs also appear in the Templates tab —
  // these were saved back to the Klaviyo library; merchant will see them
  // twice (once as a Template, once as a Campaign). Non-blocking; just a hint.
  const libraryTemplateIds = useM(() => new Set((data.templates ?? []).map(t => t.id)), [data.templates]);

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
  const toggleCampaign = (id) => updateState(s => ({
    selectedCampaignIds: new Set(s.selectedCampaignIds.has(id)
      ? [...s.selectedCampaignIds].filter(x => x !== id)
      : [...s.selectedCampaignIds, id]),
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
  const toggleAllCampaigns = () => {
    const allSel = visibleCampaigns.every(c => state.selectedCampaignIds.has(c.campaignId));
    updateState(s => {
      const n = new Set(s.selectedCampaignIds);
      if (allSel) visibleCampaigns.forEach(c => n.delete(c.campaignId));
      else visibleCampaigns.forEach(c => n.add(c.campaignId));
      return { selectedCampaignIds: n };
    });
  };

  const clearSelection = () => updateState({ selectedFlowIds: new Set(), selectedTmplIds: new Set(), selectedCampaignIds: new Set() });
  const totalSelected = state.selectedFlowIds.size + state.selectedTmplIds.size + state.selectedCampaignIds.size;

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0">
      <Tabs
        tab={state.tab} onChange={(t) => updateState({ tab: t })}
        flowCount={data.flows.length} tmplCount={data.templates.length} campaignCount={(data.campaigns ?? []).length}
        flowSelCount={state.selectedFlowIds.size} tmplSelCount={state.selectedTmplIds.size} campaignSelCount={state.selectedCampaignIds.size}
      />

      {totalSelected > 0 && (
        <SelectionBar
          flowCount={state.selectedFlowIds.size} tmplCount={state.selectedTmplIds.size} campaignCount={state.selectedCampaignIds.size}
          onClear={clearSelection} onImport={onImport}
        />
      )}

      {data.loading && (
        <CatalogLoadingPanel progress={data.loadProgress || EMPTY_PROGRESS} />
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
            noContentNote={
              !data.loading && (data.flowsTotal ?? 0) > data.flows.length
                ? `${(data.flowsTotal ?? 0) - data.flows.length} hidden — Klaviyo listed them but no importable email content was found (SMS-only, empty, orphaned messages, or a transient fetch failure).`
                : null
            }
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
        ) : state.tab === "campaigns" ? (
          <ListShell
            items={visibleCampaigns} selectedIds={state.selectedCampaignIds}
            onToggle={toggleCampaign} onToggleAll={toggleAllCampaigns}
            filter={state.campaignFilter} onFilterChange={(v) => updateState({ campaignFilter: v })}
            statusFilter={state.campaignStatus} onStatusFilterChange={(v) => updateState({ campaignStatus: v })}
            statuses={["sent", "scheduled", "sending", "draft", "cancelled"]}
            hideAlreadyImported={state.hideCampaign} onHideAlreadyImportedChange={(v) => updateState({ hideCampaign: v })}
            alreadyImportedCount={campaignsAlreadyCount}
            countLabel={`${(data.campaigns ?? []).length} campaigns`}
            emptyText={
              data.loading
                ? "Loading campaigns from Klaviyo…"
                : data.error
                ? `Error: ${data.error}`
                : "No campaigns match these filters."
            }
            renderRow={(campaign, selected, toggle) => (
              <CampaignRow key={campaign.campaignId} campaign={campaign} selected={selected} onToggle={toggle}
                alreadyImported={imports.campaigns.has(campaign.campaignId)}
                inProgress={inProgress.has(campaign.campaignId)}
                lastResult={lastResult.get(campaign.campaignId)}
                libraryTemplateIds={libraryTemplateIds}/>
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

// Catalog-fetch loading panel. Shown above the (empty) tab content while
// templates / flows / campaigns stream in from Klaviyo. Each section has
// its own status row + (for flows) a live "X of Y scanned" progress bar
// so the user can see exactly what's happening during the 10-30s wait.
function CatalogLoadingPanel({ progress }) {
  const flow = progress?.flows || { status: "pending" };
  const tmpl = progress?.templates || { status: "pending" };
  const camp = progress?.campaigns || { status: "pending" };

  // Flow scanning progress percentage. We have a "discovered" status as
  // soon as the flow list is paginated (so we know `total`), and then
  // `progress` events update `scanned` per-flow. Before discovery we show
  // an indeterminate state.
  const flowKnownTotal = typeof flow.total === "number" && flow.total > 0;
  const flowScanned = typeof flow.scanned === "number" ? flow.scanned : 0;
  const flowPct = flowKnownTotal ? Math.min(100, Math.round((flowScanned / flow.total) * 100)) : null;

  return (
    <div className="px-4 py-3 border-b border-[#21262d] bg-[#0d1117]">
      <div className="text-[11px] text-[#8b949e] mb-2">
        Fetching catalog from Klaviyo… (this can take 10–30s on large accounts)
      </div>
      <div className="flex flex-col gap-1.5">
        <SectionRow label="Templates" section={tmpl} />
        <SectionRow label="Campaigns" section={camp} />
        <div>
          <SectionRow
            label="Flows"
            section={flow}
            extra={
              flow.status === "progress" && flow.currentName
                ? `scanning "${flow.currentName.slice(0, 50)}"`
                : flow.status === "discovered" && flowKnownTotal
                ? `${flow.total} flows found, scanning…`
                : null
            }
            progressText={flowKnownTotal && (flow.status === "progress" || flow.status === "discovered")
              ? `${flowScanned}/${flow.total}`
              : null}
          />
          {(flow.status === "progress" || flow.status === "discovered") && (
            <div className="mt-1 ml-[18px] mr-2 h-[3px] bg-[#21262d] rounded-full overflow-hidden">
              <div
                className="h-full transition-all duration-300"
                style={{
                  width: flowPct !== null ? `${flowPct}%` : "20%",
                  background: "#388bfd",
                  // Indeterminate-ish look before discovery — slow pulse via opacity.
                  opacity: flowPct === null ? 0.5 : 1,
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionRow({ label, section, extra, progressText }) {
  const status = section?.status ?? "pending";
  // Status pip: pending = dim dot, loading/discovered/progress = blue
  // spinner-style dot, done = green check, error = red x.
  let pip;
  if (status === "done") {
    pip = <span className="text-[#3fb950]">✓</span>;
  } else if (status === "error") {
    pip = <span className="text-[#f85149]">✕</span>;
  } else if (status === "pending") {
    pip = <span className="text-[#484f58]">○</span>;
  } else {
    // loading / discovered / progress — animated dot
    pip = <span className="text-[#388bfd] animate-pulse">●</span>;
  }
  const labelTone =
    status === "done" ? "text-[#8b949e]"
    : status === "error" ? "text-[#f85149]"
    : status === "pending" ? "text-[#6e7681]"
    : "text-[#e6edf3]";
  const countText =
    status === "done" && typeof section.count === "number"
      ? `${section.count} found`
      : null;
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-3 flex-shrink-0 text-center">{pip}</span>
      <span className={"w-[80px] flex-shrink-0 " + labelTone}>{label}</span>
      {extra && <span className="text-[10px] text-[#6e7681] truncate">{extra}</span>}
      {(countText || progressText) && (
        <span className="ml-auto text-[10px] text-[#6e7681] tabular-nums flex-shrink-0">
          {progressText || countText}
        </span>
      )}
      {status === "error" && section.error && (
        <span className="ml-auto text-[10px] text-[#f85149] truncate max-w-[300px]">
          {section.error}
        </span>
      )}
    </div>
  );
}

function Tabs({ tab, onChange, flowCount, tmplCount, campaignCount, flowSelCount, tmplSelCount, campaignSelCount }) {
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
      {mk("campaigns", "Campaigns", campaignCount, campaignSelCount)}
      {mk("templates", "Templates", tmplCount, tmplSelCount)}
    </div>
  );
}

function SelectionBar({ flowCount, tmplCount, campaignCount, onClear, onImport }) {
  const total = flowCount + tmplCount + campaignCount;
  const parts = [];
  if (flowCount) parts.push(`${flowCount} flow${flowCount === 1 ? "" : "s"}`);
  if (campaignCount) parts.push(`${campaignCount} campaign${campaignCount === 1 ? "" : "s"}`);
  if (tmplCount) parts.push(`${tmplCount} template${tmplCount === 1 ? "" : "s"}`);
  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-[#0d1117] border-b border-[#21262d]">
      <span className="text-[12px] text-[#e6edf3] tabular-nums">
        <strong className="font-semibold">{total}</strong> selected
        <span className="text-[#6e7681] ml-1.5">({parts.join(", ")})</span>
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

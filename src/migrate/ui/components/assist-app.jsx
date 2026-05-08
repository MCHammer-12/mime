// Assist UI root.
//
// Hash-based router: `#/` (or empty) → store picker; `#/store/:storeId` →
// per-store items list. The `?as=<name>` query param identifies the
// assistant for note attribution; it's read once at boot and bookmarked
// per-assistant ("…/?as=alex"). No login.

const { useState: useStateApp, useEffect: useEffectApp, useCallback: useCApp } = React;

function readAuthorFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("as");
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, 60);
  } catch (_) {
    return null;
  }
}

function readRouteFromHash() {
  const h = window.location.hash || "";
  const m = h.match(/^#\/store\/([^/?]+)/);
  if (m) return { view: "store", storeId: decodeURIComponent(m[1]) };
  return { view: "list" };
}

function AssistApp() {
  const [route, setRoute] = useStateApp(readRouteFromHash);
  const [author] = useStateApp(readAuthorFromUrl);

  const [stores, setStores] = useStateApp([]);
  const [storesLoading, setStoresLoading] = useStateApp(true);

  const [items, setItems] = useStateApp([]);
  const [itemsLoading, setItemsLoading] = useStateApp(false);
  // Returned alongside items so a deep-link to /#/store/<id> can render
  // the brand name even when we never loaded the stores list.
  const [itemsStoreName, setItemsStoreName] = useStateApp(null);

  // React to back/forward + manual hash edits.
  useEffectApp(() => {
    const onHashChange = () => setRoute(readRouteFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Load stores once. Cheap query; we re-fetch when leaving a store detail
  // so a freshly-imported brand shows up without a hard refresh.
  const loadStores = useCApp(async () => {
    setStoresLoading(true);
    try {
      const r = await fetch("/api/assist/stores");
      const j = await r.json();
      setStores(j.stores || []);
    } catch (e) {
      console.warn("loadStores failed:", e);
    } finally {
      setStoresLoading(false);
    }
  }, []);

  useEffectApp(() => {
    if (route.view === "list") loadStores();
  }, [route.view, loadStores]);

  // Load items when a store is opened.
  useEffectApp(() => {
    if (route.view !== "store") return;
    let cancelled = false;
    setItemsLoading(true);
    setItems([]);
    setItemsStoreName(null);
    fetch(`/api/assist/stores/${encodeURIComponent(route.storeId)}/items`)
      .then(r => r.json())
      .then(j => {
        if (cancelled) return;
        setItems(j.items || []);
        setItemsStoreName(j.storeName || null);
      })
      .catch(e => console.warn("loadItems failed:", e))
      .finally(() => {
        if (!cancelled) setItemsLoading(false);
      });
    return () => { cancelled = true; };
  }, [route.view, route.view === "store" ? route.storeId : null]);

  const onSaveNote = useCApp(async (itemId, note) => {
    if (route.view !== "store") return null;
    try {
      const r = await fetch(
        `/api/assist/stores/${encodeURIComponent(route.storeId)}/items/${encodeURIComponent(itemId)}/note`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note, author: author || undefined }),
        },
      );
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      console.warn("save note failed:", e);
      return null;
    }
  }, [route, author]);

  const openStore = (storeId) => {
    window.location.hash = `#/store/${encodeURIComponent(storeId)}`;
  };
  const goBack = () => {
    window.location.hash = "";
  };

  const currentStore = route.view === "store"
    ? stores.find(s => s.storeId === route.storeId)
      || (itemsStoreName ? { storeId: route.storeId, storeName: itemsStoreName } : { storeName: route.storeId })
    : null;

  return (
    <div className="h-screen w-screen flex flex-col bg-[#0d1117] text-[#e6edf3] font-sans">
      <header className="flex items-center gap-3 px-4 py-2 border-b border-[#21262d] bg-[#010409]">
        <span className="font-serif text-[22px] leading-none text-[#e6edf3]">redo</span>
        {author && (
          <span className="ml-auto text-[11px] text-[#6e7681]">
            signed as <span className="text-[#8b949e]">{author}</span>
          </span>
        )}
      </header>
      <div className="flex flex-1 overflow-hidden">
        {route.view === "list" ? (
          <AssistStores
            stores={stores}
            loading={storesLoading}
            onOpenStore={openStore}
          />
        ) : (
          <AssistItems
            store={currentStore}
            items={items}
            loading={itemsLoading}
            author={author}
            onSaveNote={onSaveNote}
            onBack={goBack}
          />
        )}
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<AssistApp/>);

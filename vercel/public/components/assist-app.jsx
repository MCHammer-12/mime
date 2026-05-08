// Assist UI root (Vercel deploy).
//
// Hash-based router: `#/` (or empty) → store picker; `#/store/:storeId` →
// per-store items list. Two query params at boot:
//
//   ?t=<token>  shared secret matched against ASSIST_TOKEN env var on
//               the server. Required — every API call appends it.
//   ?as=<name>  assistant identity (Dennis, Toby, …). Drives note
//               attribution + per-assistant done state and the Mine|All
//               filter on the brand picker.
//
// Both are bookmarked per-assistant: each gets a unique URL like
//   https://redo-notes.vercel.app/?t=abc123&as=Dennis

const { useState: useStateApp, useEffect: useEffectApp, useCallback: useCApp } = React;

function readQueryParam(name, max) {
  try {
    const raw = new URLSearchParams(window.location.search).get(name);
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return max ? trimmed.slice(0, max) : trimmed;
  } catch (_) {
    return null;
  }
}

function readAuthorFromUrl() { return readQueryParam("as", 60); }
function readTokenFromUrl()  { return readQueryParam("t", 200); }

function readRouteFromHash() {
  const h = window.location.hash || "";
  const m = h.match(/^#\/store\/([^/?]+)/);
  if (m) return { view: "store", storeId: decodeURIComponent(m[1]) };
  return { view: "list" };
}

function AssistApp() {
  const [route, setRoute] = useStateApp(readRouteFromHash);
  const [author] = useStateApp(readAuthorFromUrl);
  const [token] = useStateApp(readTokenFromUrl);

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

  // Build the query string appended to every API call. `t` is required
  // (server 401s otherwise); `as` populates per-assistant state and is
  // optional but recommended.
  const apiQuery = (() => {
    const parts = [];
    if (token) parts.push(`t=${encodeURIComponent(token)}`);
    if (author) parts.push(`as=${encodeURIComponent(author)}`);
    return parts.length ? `?${parts.join("&")}` : "";
  })();
  const asQuery = apiQuery; // legacy alias used below

  // Load stores once. Cheap query; we re-fetch when leaving a store detail
  // so a freshly-imported brand shows up without a hard refresh.
  const loadStores = useCApp(async () => {
    setStoresLoading(true);
    try {
      const r = await fetch(`/api/assist/stores${asQuery}`);
      const j = await r.json();
      setStores(j.stores || []);
    } catch (e) {
      console.warn("loadStores failed:", e);
    } finally {
      setStoresLoading(false);
    }
  }, [asQuery]);

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
    fetch(`/api/assist/stores/${encodeURIComponent(route.storeId)}/items${asQuery}`)
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
  }, [route.view, route.view === "store" ? route.storeId : null, asQuery]);

  // Token is required on POSTs too — pass it as a query param so the
  // server-side requireToken() check passes.
  const tokenQuery = token ? `?t=${encodeURIComponent(token)}` : "";

  const onSaveNote = useCApp(async (itemId, note) => {
    if (route.view !== "store") return null;
    try {
      const r = await fetch(
        `/api/assist/stores/${encodeURIComponent(route.storeId)}/items/${encodeURIComponent(itemId)}/note${tokenQuery}`,
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
  }, [route, author, tokenQuery]);

  const onToggleDone = useCApp(async (itemId, done) => {
    if (route.view !== "store" || !author) return false;
    try {
      const r = await fetch(
        `/api/assist/stores/${encodeURIComponent(route.storeId)}/items/${encodeURIComponent(itemId)}/done${tokenQuery}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ done, author }),
        },
      );
      if (!r.ok) return false;
      // Mirror in local items state so the row stays in sync if we revisit.
      setItems(its => its.map(it => it.itemId === itemId ? { ...it, done } : it));
      return true;
    } catch (e) {
      console.warn("toggle done failed:", e);
      return false;
    }
  }, [route, author, tokenQuery]);

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

  // No-token landing screen. Shown when the URL was opened without a
  // ?t= param — almost always means someone shared the bare deploy URL
  // without the access token. Friendly hint, no API calls fire.
  if (!token) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[#0d1117] text-[#e6edf3] font-sans px-4">
        <div className="max-w-[420px] text-center">
          <div className="font-serif text-[40px] leading-[1] text-[#e6edf3] mb-3">redo</div>
          <p className="text-[12px] text-[#8b949e] leading-relaxed">
            This page needs an access link. Ask Michael for the URL with your
            name attached, e.g.<br/>
            <code className="text-[#6e7681]">?t=…&amp;as=YourName</code>
          </p>
        </div>
      </div>
    );
  }

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
            author={author}
            onOpenStore={openStore}
          />
        ) : (
          <AssistItems
            store={currentStore}
            items={items}
            loading={itemsLoading}
            author={author}
            onSaveNote={onSaveNote}
            onToggleDone={onToggleDone}
            onBack={goBack}
          />
        )}
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<AssistApp/>);

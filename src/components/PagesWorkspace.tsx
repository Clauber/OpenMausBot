import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Plus, Save } from "lucide-react";
import { api, ApiError, openThread, useStore } from "@/state/store";
import { ChatMarkdown } from "./ChatMarkdown";
import type { Page } from "../../shared/pages";

const navigate = (id?: string) => { window.location.hash = id ? `/pages/${id}` : "/pages"; };
export function pageIdFromHash(): string | null {
  return window.location.hash.match(/^#\/pages\/([\w-]+)$/)?.[1] ?? null;
}
type LocalDraft = { title: string; content: string; revision: number };
function readDraft(key: string): LocalDraft | null {
  try {
    const data = JSON.parse(localStorage.getItem(key) ?? "null");
    return data && typeof data.title === "string" && typeof data.content === "string" && Number.isInteger(data.revision) ? data : null;
  } catch { return null; }
}

function PageEditor({ initial, pages, refresh, draftKey }: { initial: Page; pages: Page[]; refresh: () => void; draftKey: string }) {
  const { state, dispatch } = useStore();
  const cached = useRef(readDraft(draftKey));
  const [page, setPage] = useState(initial);
  const [title, setTitle] = useState(cached.current?.title ?? initial.title);
  const [content, setContent] = useState(cached.current?.content ?? initial.content);
  const [revision, setRevision] = useState(cached.current?.revision ?? initial.revision);
  const [conflict, setConflict] = useState(Boolean(cached.current && cached.current.revision !== initial.revision));
  const [status, setStatus] = useState(cached.current ? "Draft restored" : "Saved");
  const [busy, setBusy] = useState(false);
  const [autosavePaused, setAutosavePaused] = useState(false);
  const saving = useRef(false);
  const mounted = useRef(true);
  const latest = useRef({ title, content }); latest.current = { title, content };
  const [botId, setBotId] = useState(state.bots.find((bot) => !bot.hidden)?.id ?? "");
  const sourceOwner = [...state.bots, ...state.groups].find((owner) => owner.threadId === page.sourceThreadId || owner.tasks?.some((task) => task.threadId === page.sourceThreadId));
  const dirty = title !== page.title || content !== page.content;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Synchronous change handlers retain each keystroke, even if navigation or
  // closing the window happens before an autosave timer/effect can run.
  const retain = (draft: LocalDraft) => {
    try { localStorage.setItem(draftKey, JSON.stringify(draft)); }
    catch { setStatus("Draft storage unavailable — save before leaving"); }
  };
  const save = useCallback(async (overwrite = false) => {
    if (saving.current) return;
    saving.current = true; setBusy(true); setStatus("Saving…");
    const snapshot = { ...latest.current };
    try {
      const expected = overwrite ? (await api<{ page: Page }>(`/api/pages/${page.id}`)).page.revision : revision;
      const result = await api<{ page: Page }>(`/api/pages/${page.id}`, {
        method: "PATCH", body: JSON.stringify({ ...snapshot, revision: expected }),
      });
      // Keep a newer edit made while this request was in flight. Also retain
      // that edit if this editor unmounted before the response arrived.
      const retained = readDraft(draftKey);
      if (retained?.title === latest.current.title && retained.content === latest.current.content) {
        if (latest.current.title === snapshot.title && latest.current.content === snapshot.content) localStorage.removeItem(draftKey);
        else localStorage.setItem(draftKey, JSON.stringify({ ...latest.current, revision: result.page.revision }));
      }
      if (!mounted.current) return;
      setPage(result.page); setRevision(result.page.revision); setConflict(false); setAutosavePaused(false);
      setStatus(latest.current.title === snapshot.title && latest.current.content === snapshot.content ? "Saved" : "Unsaved draft");
      refresh();
    } catch (error) {
      if (!mounted.current) return;
      setAutosavePaused(true);
      if (error instanceof ApiError && error.status === 409 && error.body?.code === "stale_revision") {
        setConflict(true); setStatus("Conflict — local draft kept");
      } else setStatus(error instanceof Error ? error.message : "Save failed — draft kept");
    } finally { saving.current = false; if (mounted.current) setBusy(false); }
  }, [page.id, revision, draftKey, refresh]);
  useEffect(() => {
    if (!dirty || conflict || busy || autosavePaused || !title.trim()) return;
    const timer = window.setTimeout(() => { void save(); }, 1200);
    return () => window.clearTimeout(timer);
  }, [title, content, dirty, conflict, busy, autosavePaused, save]);
  const move = async (parentId: string | null) => {
    if (dirty || saving.current) { setStatus("Save your draft before moving"); return; }
    saving.current = true; setBusy(true);
    try {
      const result = await api<{ page: Page }>(`/api/pages/${page.id}/move`, { method: "POST", body: JSON.stringify({ parentId, revision }) });
      setPage(result.page); setRevision(result.page.revision); refresh(); setStatus("Moved");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Move failed"); }
    finally { saving.current = false; setBusy(false); }
  };
  const openChat = async () => {
    try {
      const result = await api<{ botId: string; task: { threadId: string } }>(`/api/pages/${page.id}/chat`, {
        method: "POST", body: JSON.stringify({ botId, revision }),
      });
      window.location.hash = "";
      dispatch({ type: "switchTask", botId: result.botId, threadId: result.task.threadId });
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not open chat"); }
  };
  return <section className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto p-4" aria-label="Page editor">
    <div className="flex flex-wrap items-center gap-3">
      <input aria-label="Page title" maxLength={160} className="min-w-0 flex-1 rounded-lg border border-hairline bg-card p-2 text-xl text-ink" value={title}
        onChange={(event) => { setTitle(event.target.value); setStatus("Unsaved draft"); setAutosavePaused(false); retain({ title: event.target.value, content, revision }); }} />
      <button className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-on-accent" disabled={busy || !dirty || !title.trim() || conflict} onClick={() => void save()}><Save size={16} />Save</button>
    </div>
    <div role="status" aria-live="polite" className="text-sm text-ink-secondary">{status} · revision {revision}</div>
    {conflict && <div role="alert" className="rounded-lg border border-warning p-3 text-ink">
      This page changed elsewhere. Your local draft is retained. Overwrite replaces the latest saved title and content.
      <button className="ml-3 underline" disabled={busy} onClick={() => void save(true)}>Overwrite latest with my draft</button>
    </div>}
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <label>Parent <select aria-label="Parent page" className="rounded border border-hairline bg-card p-1" value={page.parentId ?? ""} disabled={busy || dirty || conflict} onChange={(event) => void move(event.target.value || null)}>
        <option value="">Top level</option>{pages.filter((p) => p.id !== page.id).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
      </select></label>
      {page.sourceThreadId && (sourceOwner ? <button className="underline" onClick={() => openThread(dispatch, { botId: sourceOwner.id, threadId: page.sourceThreadId! }, state)}>Open source conversation</button> : <span>Source conversation: <code>{page.sourceThreadId}</code></span>)}
      <label>Chat with <select aria-label="Page chat bot" className="rounded border border-hairline bg-card p-1" value={botId} onChange={(event) => setBotId(event.target.value)}>
        <option value="">Choose bot</option>{state.bots.filter((bot) => !bot.hidden).map((bot) => <option value={bot.id} key={bot.id}>{bot.name}</option>)}
      </select></label>
      <button className="underline" disabled={!botId || dirty || conflict || busy} onClick={() => void openChat()}>Open page chat</button>
      <button className="ml-auto text-danger underline" disabled={busy || dirty} onClick={async () => {
        if (!window.confirm(`Delete “${page.title}”? Move or delete its children first.`)) return;
        try { await api(`/api/pages/${page.id}`, { method: "DELETE", body: JSON.stringify({ revision }) }); localStorage.removeItem(draftKey); navigate(); refresh(); }
        catch (error) { setStatus(error instanceof Error ? error.message : "Delete failed"); }
      }}>Delete page</button>
    </div>
    <div className="grid min-h-80 flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
      <textarea aria-label="Page markdown" maxLength={100000} className="min-h-80 w-full resize-y rounded-lg border border-hairline bg-inset p-3 font-mono text-sm text-ink" value={content}
        onChange={(event) => { setContent(event.target.value); setStatus("Unsaved draft"); setAutosavePaused(false); retain({ title, content: event.target.value, revision }); }} />
      <article aria-label="Page preview" className="min-w-0 overflow-auto rounded-lg border border-hairline bg-card p-4"><ChatMarkdown text={content} /></article>
    </div>
  </section>;
}

export function PagesWorkspace() {
  const { state } = useStore();
  const [selected, setSelected] = useState(pageIdFromHash);
  const [pages, setPages] = useState<Page[]>([]);
  const [results, setResults] = useState<Page[] | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<Page | null>(null);
  const [notice, setNotice] = useState("");
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => { const onHash = () => setSelected(pageIdFromHash()); window.addEventListener("hashchange", onHash); return () => window.removeEventListener("hashchange", onHash); }, []);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([api<{ pages: Page[] }>("/api/pages"), api<{ environmentId: string }>("/api/auth/session")])
      .then(([data, session]) => { if (!cancelled) { setPages(data.pages); setEnvironmentId(session.environmentId); } })
      .catch((error) => { if (!cancelled) setNotice(error.message); });
    return () => { cancelled = true; };
  }, [version]);
  useEffect(() => {
    let cancelled = false; setPage(null); setNotice("");
    if (selected) void api<{ page: Page }>(`/api/pages/${selected}`).then((data) => { if (!cancelled) setPage(data.page); })
      .catch((error) => { if (!cancelled) setNotice(error.message); });
    return () => { cancelled = true; };
  }, [selected]);
  useEffect(() => {
    let cancelled = false;
    if (!query.trim()) { setResults(null); return; }
    const timer = window.setTimeout(() => {
      void api<{ pages: Page[] }>(`/api/pages/search?q=${encodeURIComponent(query)}`).then((data) => { if (!cancelled) setResults(data.pages); })
        .catch((error) => { if (!cancelled) setNotice(error.message); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, version]);
  const create = async (fromThread = false) => {
    const bot = state.bots.find((b) => b.id === state.selectedId);
    const group = state.groups.find((g) => g.id === state.selectedId);
    try {
      const result = await api<{ page: Page }>(fromThread ? "/api/pages/from-conversation" : "/api/pages", {
        method: "POST", body: JSON.stringify({ title: fromThread ? "Saved conversation" : "Untitled page", revision: 0,
          ...(fromThread ? { threadId: group?.threadId ?? bot?.threadId } : { content: "", parentId: selected }), }),
      });
      navigate(result.page.id); refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Create failed"); }
  };
  const depth = (p: Page) => {
    let count = 0, parent = p.parentId;
    const seen = new Set([p.id]);
    while (parent && !seen.has(parent)) { seen.add(parent); count++; parent = pages.find((item) => item.id === parent)?.parentId ?? null; }
    return Math.min(count, 8);
  };
  const tree = (parentId: string | null): Page[] => pages.filter((item) => item.parentId === parentId).flatMap((item) => [item, ...tree(item.id)]);
  return <main className="flex h-full min-w-0 flex-1 flex-col bg-app text-ink" aria-label="Pages workspace">
    <header className="flex flex-wrap items-center gap-3 border-b border-hairline p-4"><FileText size={22} /><h1 className="text-xl font-semibold">Pages</h1>
      <button className="flex items-center gap-1 rounded-lg border border-hairline px-3 py-2" onClick={() => void create()}><Plus size={16} />{selected ? "New child page" : "New page"}</button>
      <button className="rounded-lg border border-hairline px-3 py-2" disabled={!state.selectedId} onClick={() => void create(true)}>Save conversation as page</button>
      {selected && <button className="underline" onClick={() => navigate()}>All pages</button>}
    </header>
    {notice && <p role="alert" className="p-3 text-danger">{notice}</p>}
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav aria-label="Page tree" className="max-h-52 shrink-0 overflow-auto border-b border-hairline p-3 md:max-h-none md:w-60 md:border-r">
        <input aria-label="Search pages" placeholder="Search pages" className="mb-3 w-full rounded border border-hairline bg-card p-2" value={query} onChange={(event) => setQuery(event.target.value)} />
        {(results ?? tree(null)).map((item) => <a key={item.id} href={`#/pages/${item.id}`} aria-current={item.id === selected ? "page" : undefined}
          style={{ paddingLeft: `${8 + (results ? 0 : depth(item)) * 12}px` }} className="block truncate rounded py-2 text-sm hover:bg-raised">{item.title}</a>)}
        {!pages.length && <p className="text-sm text-ink-secondary">Create a page or save a conversation.</p>}
      </nav>
      {page && environmentId ? <PageEditor key={page.id} initial={page} pages={pages} refresh={refresh} draftKey={`legion-page-draft:${environmentId}:${page.id}`} />
        : <p className="p-6 text-ink-secondary">{selected ? notice ? "Page unavailable." : "Loading page…" : "Choose a page to edit and preview."}</p>}
    </div>
  </main>;
}

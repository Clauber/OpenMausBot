import {
  ArrowUp, ChevronDown, ChevronRight, Download, File, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Folder,
  FolderOpen, RefreshCw, X, type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { formatSize } from "@/lib/composer-attachments";
import {
  absoluteIn, changedFileMarks, climbedState, readFileTreeState, treeRows, writeFileTreeState,
  type FileTreeState, type FolderEntry, type FolderListing, type TreeRow,
} from "@/lib/file-tree";
import { t } from "@/lib/i18n";
import { shortPath } from "@/lib/short-path";

const TEXT_PREVIEW_BYTES = 1024 * 1024;
const BUSY_REFRESH_MS = 3_000;
const CODE_EXTENSIONS = /\.(c|cc|cpp|css|go|h|html?|java|jsx?|json|kt|mjs|php|py|rb|rs|sh|sql|swift|tsx?|toml|ya?ml|xml)$/i;

interface Meta { roots: string[]; base: string; canGoUp: boolean }

function filesUrl(bot: Bot, up: number, root: number, path: string, raw = false): string {
  const query = new URLSearchParams({ threadId: bot.threadId, root: String(root), up: String(root === 0 ? up : 0), path });
  return `/api/bots/${encodeURIComponent(bot.id)}/files${raw ? "/raw" : ""}?${query}`;
}

function iconFor(entry: FolderEntry): LucideIcon {
  const kind = entry.mime.split("/")[0];
  if (kind === "image") return FileImage;
  if (kind === "video") return FileVideo;
  if (kind === "audio") return FileAudio;
  if (/csv|tab-separated|spreadsheet|excel/.test(entry.mime)) return FileSpreadsheet;
  if (CODE_EXTENSIONS.test(entry.name)) return FileCode;
  if (kind === "text" || entry.mime === "application/pdf") return FileText;
  return File;
}

const baseName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

function TextPreview({ src }: { src: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setText(null);
    fetch(src, { signal: controller.signal, cache: "no-store" })
      .then((response) => response.ok ? response.text() : Promise.reject(new Error(response.statusText)))
      .then(setText, () => { if (!controller.signal.aborted) setText(t("computer.files.noPreview")); });
    return () => controller.abort();
  }, [src]);
  return <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[12px] text-ink">{text ?? "…"}</pre>;
}

function FileView({ entry, src }: { entry: FolderEntry; src: string }) {
  const kind = entry.mime.split("/")[0];
  const media = "max-h-full max-w-full object-contain";
  if (kind === "image") return <div className="flex min-h-0 flex-1 items-center justify-center p-3"><img src={src} alt={entry.name} className={cn(media, "rounded")} /></div>;
  if (kind === "video") return <div className="flex min-h-0 flex-1 items-center justify-center bg-black"><video key={src} src={src} controls className={media} /></div>;
  if (kind === "audio") return <div className="p-3"><audio key={src} src={src} controls className="w-full" /></div>;
  if (entry.mime === "application/pdf") return <iframe src={src} title={entry.name} className="min-h-0 w-full flex-1 bg-white" />;
  if ((kind === "text" || entry.mime === "application/json") && entry.bytes <= TEXT_PREVIEW_BYTES) return <TextPreview src={src} />;
  return <p className="p-3 text-[12px] leading-5 text-ink-secondary">{t("computer.files.noPreview")}</p>;
}

/** VS Code-style explorer over the bot's folders for this chat, read through the server so a remote app sees the same files. */
export function BotFolderBrowser({ bot, home }: { bot: Bot; home?: string }) {
  const [state, setState] = useState<FileTreeState>(() => readFileTreeState(bot.id, bot.threadId));
  const [meta, setMeta] = useState<Meta | null>(null);
  const [listings, setListings] = useState<Map<string, FolderListing>>(() => new Map());
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [split, setSplit] = useState(40);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const container = useRef<HTMLDivElement>(null);
  const stateKey = `${bot.id}:${bot.threadId}`;
  const loadedKey = useRef(stateKey);

  useEffect(() => {
    if (loadedKey.current === stateKey) return;
    loadedKey.current = stateKey;
    setState(readFileTreeState(bot.id, bot.threadId));
    setMeta(null);
    setListings(new Map());
    setErrors(new Map());
  }, [stateKey]);
  useEffect(() => { writeFileTreeState(bot.id, bot.threadId, state); }, [stateKey, state]);

  const load = useCallback(async (keys: readonly string[], signal?: AbortSignal) => {
    await Promise.all(keys.map(async (key) => {
      const cut = key.indexOf(":");
      const root = Number(key.slice(0, cut));
      try {
        const response = await fetch(filesUrl(bot, state.up, root, key.slice(cut + 1)), { signal, cache: "no-store" });
        const body = await response.json().catch(() => null) as (FolderListing & Meta & { error?: string }) | null;
        if (!response.ok || !body) throw new Error(body?.error ?? response.statusText);
        if (signal?.aborted) return;
        if (root === 0) setMeta({ roots: body.roots, base: body.base, canGoUp: body.canGoUp });
        else setMeta((current) => current ?? { roots: body.roots, base: "", canGoUp: false });
        setListings((current) => new Map(current).set(key, { folders: body.folders, entries: body.entries, truncated: body.truncated }));
        setErrors((current) => { const next = new Map(current); next.delete(key); return next; });
      } catch (error) {
        if (signal?.aborted) return;
        setErrors((current) => new Map(current).set(key, t("computer.files.loadFailed", { error: (error as Error).message })));
      }
    }));
  }, [bot.id, bot.threadId, state.up]);

  const missing = state.expanded.filter((key) => !listings.has(key) && !errors.has(key));
  useEffect(() => {
    if (missing.length === 0) return;
    const controller = new AbortController();
    void load(missing, controller.signal);
    return () => controller.abort();
  }, [load, missing.join("\n")]);

  const refresh = useCallback(() => void load(state.expanded), [load, state.expanded]);
  const lastDigest = useMemo(() => [...bot.messages].reverse().find((message) => message.digest)?.id, [bot.messages]);
  const firstDigest = useRef(lastDigest);
  useEffect(() => {
    if (firstDigest.current === lastDigest) return;
    firstDigest.current = lastDigest;
    refresh();
  }, [lastDigest]);
  useEffect(() => {
    if (!bot.busy) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, BUSY_REFRESH_MS);
    return () => clearInterval(timer);
  }, [bot.busy, refresh]);

  const rootNames = meta ? [baseName(meta.base) || meta.base, ...(meta.roots.length > 1 ? [t("computer.files.sharedFolder")] : [])] : [];
  const rows = treeRows(rootNames, state, listings, errors);
  const navigable = rows.filter((row): row is Exclude<TreeRow, { kind: "note" }> => row.kind !== "note");
  const marks = useMemo(() => changedFileMarks(bot), [bot.messages, bot.activeLeafId, bot.threadId, bot.tasks, bot.cwd]);
  const rootBase = (root: number) => (root === 0 ? meta?.base ?? "" : meta?.roots[root] ?? "");
  const openedRow = state.opened && navigable.find((row) => row.kind === "file" && row.root === state.opened!.root && row.path === state.opened!.path);
  const activeKey = focusKey && navigable.some((row) => row.key === focusKey) ? focusKey : (openedRow?.key ?? navigable[0]?.key);

  const toggle = (key: string, open?: boolean) => setState((current) => {
    const isOpen = current.expanded.includes(key);
    if (open === isOpen) return current;
    if (!isOpen) setErrors((existing) => { const next = new Map(existing); next.delete(key); return next; });
    return { ...current, expanded: isOpen ? current.expanded.filter((candidate) => candidate !== key) : [...current.expanded, key] };
  });
  const openFile = (row: Extract<TreeRow, { kind: "file" }>) => setState((current) => ({ ...current, opened: { root: row.root, path: row.path, mime: row.entry.mime, bytes: row.entry.bytes } }));
  const goUp = () => {
    if (!meta?.canGoUp) return;
    setListings((current) => new Map([...current].filter(([key]) => !key.startsWith("0:"))));
    setErrors(new Map());
    setState((current) => climbedState(current, baseName(meta.base)));
  };
  const focusRow = (key: string | undefined) => {
    if (!key) return;
    setFocusKey(key);
    rowRefs.current.get(key)?.focus();
  };

  const onTreeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = navigable.findIndex((row) => row.key === activeKey);
    const row = navigable[index];
    if (!row) return;
    const move = (target: number) => focusRow(navigable[Math.max(0, Math.min(navigable.length - 1, target))]?.key);
    switch (event.key) {
      case "ArrowDown": move(index + 1); break;
      case "ArrowUp": move(index - 1); break;
      case "Home": move(0); break;
      case "End": move(navigable.length - 1); break;
      case "ArrowRight":
        if (row.kind === "folder" && !row.expanded) toggle(row.key, true);
        else if (row.kind === "folder" && navigable[index + 1]?.depth === row.depth + 1) move(index + 1);
        break;
      case "ArrowLeft":
        if (row.kind === "folder" && row.expanded) toggle(row.key, false);
        else focusRow(navigable.slice(0, index).reverse().find((candidate) => candidate.depth === row.depth - 1)?.key);
        break;
      case "Enter":
      case " ":
        if (row.kind === "folder") toggle(row.key);
        else openFile(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onDividerDown = (event: PointerEvent<HTMLDivElement>) => {
    const box = container.current?.getBoundingClientRect();
    if (!box) return;
    const across = getComputedStyle(container.current!).flexDirection === "row";
    event.currentTarget.setPointerCapture(event.pointerId);
    const onMove = (move: globalThis.PointerEvent) => {
      const ratio = across ? (move.clientX - box.left) / box.width : (move.clientY - box.top) / box.height;
      setSplit(Math.round(Math.min(80, Math.max(20, ratio * 100))));
    };
    const target = event.currentTarget;
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", () => target.removeEventListener("pointermove", onMove), { once: true });
  };

  const opened = state.opened;
  const openedSrc = opened && filesUrl(bot, state.up, opened.root, opened.path, true);
  const openedName = opened ? baseName(opened.path) : "";
  const OpenedIcon = opened ? iconFor({ name: openedName, bytes: opened.bytes, mime: opened.mime }) : File;
  const headerButton = "shrink-0 rounded p-1 text-ink-secondary hover:bg-raised-hover hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <div className="@container/files flex min-h-0 flex-1 flex-col" data-testid="computer-folder-browser">
      <div ref={container} className="flex min-h-0 flex-1 flex-col @min-[36rem]/files:flex-row">
        <div className={cn("flex min-h-0 min-w-0 flex-col", opened ? "shrink-0" : "flex-1")} style={opened ? { flexBasis: `${split}%` } : undefined}>
          <div className="flex shrink-0 items-center gap-1 px-3 py-2">
            <button type="button" className={headerButton} onClick={goUp} disabled={!meta?.canGoUp} aria-label={t("computer.files.up")} title={t("computer.files.up")}>
              <ArrowUp size={14} aria-hidden="true" />
            </button>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-secondary" title={meta?.base}>{meta ? shortPath(meta.base, home) : "…"}</span>
            <button type="button" className={headerButton} onClick={refresh} aria-label={t("computer.files.refresh")} title={t("computer.files.refresh")}>
              <RefreshCw size={13} aria-hidden="true" />
            </button>
          </div>
          <div role="tree" aria-label={t("computer.files.browse")} className="min-h-0 flex-1 overflow-auto pb-2" onKeyDown={onTreeKey}>
            {rows.map((row) => {
              const indent = { paddingLeft: `${8 + row.depth * 12}px` };
              if (row.kind === "note") {
                const text = row.note === "loading" ? "…" : row.note === "truncated" ? t("computer.files.truncated") : row.note;
                return <div key={row.key} role="none" style={indent} className="truncate py-0.5 pr-2 text-[11px] text-ink-tertiary">{text}</div>;
              }
              const absolute = absoluteIn(rootBase(row.root), row.path);
              const mark = row.kind === "file" ? marks.files.get(absolute) : undefined;
              const changedInside = row.kind === "folder" && marks.folders.has(absolute);
              const selected = row.kind === "file" && row.key === openedRow?.key;
              const Icon = row.kind === "folder" ? (row.expanded ? FolderOpen : Folder) : iconFor(row.entry);
              return (
                <div
                  key={row.key}
                  ref={(element) => { if (element) rowRefs.current.set(row.key, element); else rowRefs.current.delete(row.key); }}
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-expanded={row.kind === "folder" ? row.expanded : undefined}
                  aria-selected={row.kind === "file" ? selected : undefined}
                  tabIndex={row.key === activeKey ? 0 : -1}
                  title={absolute}
                  style={indent}
                  onFocus={() => setFocusKey(row.key)}
                  onClick={() => (row.kind === "folder" ? toggle(row.key) : openFile(row))}
                  className={cn(
                    "flex h-[22px] cursor-pointer select-none items-center gap-1 pr-2 text-[12.5px] text-ink outline-none hover:bg-raised-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent",
                    selected && "bg-control",
                    row.depth === 0 && "font-medium",
                  )}
                >
                  {row.kind === "folder"
                    ? (row.expanded ? <ChevronDown size={13} className="shrink-0 text-ink-secondary" aria-hidden="true" /> : <ChevronRight size={13} className="shrink-0 text-ink-secondary" aria-hidden="true" />)
                    : <span className="w-[13px] shrink-0" aria-hidden="true" />}
                  <Icon size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
                  <span className={cn("min-w-0 flex-1 truncate", mark === "A" && "text-success", mark === "M" && "text-warning")}>{row.name}</span>
                  {mark && <span className={cn("shrink-0 text-[11px] font-medium", mark === "A" ? "text-success" : "text-warning")} title={t(mark === "A" ? "computer.files.added" : "computer.files.modified")}>{mark}</span>}
                  {changedInside && <span className="size-1.5 shrink-0 rounded-full bg-warning" title={t("computer.files.changedInside")} />}
                </div>
              );
            })}
          </div>
        </div>
        {opened && openedSrc && (
          <>
            <div
              role="separator"
              aria-label={t("computer.files.resize")}
              aria-valuenow={split}
              aria-valuemin={20}
              aria-valuemax={80}
              tabIndex={0}
              onPointerDown={onDividerDown}
              onKeyDown={(event) => {
                const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 5 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -5 : 0;
                if (!step) return;
                event.preventDefault();
                setSplit((value) => Math.min(80, Math.max(20, value + step)));
              }}
              className="h-1 shrink-0 cursor-row-resize touch-none bg-hairline hover:bg-raised-hover focus-visible:bg-accent @min-[36rem]/files:h-auto @min-[36rem]/files:w-1 @min-[36rem]/files:cursor-col-resize"
            />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center gap-1.5 border-b border-hairline px-3 py-1.5">
                <OpenedIcon size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink" title={absoluteIn(rootBase(opened.root), opened.path)}>{openedName}</span>
                <span className="shrink-0 text-[11px] text-ink-tertiary">{formatSize(opened.bytes)}</span>
                <a href={`${openedSrc}&download=1`} download={openedName} className={headerButton} aria-label={t("computer.files.download")} title={t("computer.files.download")}>
                  <Download size={13} aria-hidden="true" />
                </a>
                <button type="button" className={headerButton} onClick={() => setState((current) => ({ ...current, opened: null }))} aria-label={t("computer.files.close")} title={t("computer.files.close")}>
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
              <FileView entry={{ name: openedName, bytes: opened.bytes, mime: opened.mime }} src={openedSrc} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

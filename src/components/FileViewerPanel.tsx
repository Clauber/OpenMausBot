// The docked file viewer: attachments and bot-authored file links open here
// as tabs instead of downloading. Bytes always come through the
// message-scoped file route, so the server re-proves the grant on every tab.
import { useCallback, useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Check,
  Download,
  Files,
  LoaderCircle,
  RotateCcw,
  TriangleAlert,
  X,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  FILE_VIEWER_TEXT_MAX_BYTES,
  fileViewerKind,
  formatByteSize,
  textPreviewExceeds,
  type FileViewerKind,
  type FileViewerTab,
} from "@/lib/file-viewer";
import { useStore } from "@/state/store";
import { ChatMarkdown, CodeBlock } from "./ChatMarkdown";
import { fileLanguage, filePreviewKind, sandboxedHtml } from "@/lib/file-preview";
import { useCaptionChrome } from "./DesktopCapabilities";
import { requestMessageFile, useLocalFileSave } from "./AttachmentPreview";

interface ReadyContent {
  kind: FileViewerKind;
  blobUrl?: string;
  text?: string;
  truncated?: boolean;
  mime: string | null;
  bytes: number | null;
}

type ContentState =
  | { status: "loading" }
  | { status: "ready"; content: ReadyContent }
  | { status: "failed"; message: string };

/** Bounded text read: stop one chunk past the cap, then decode once. */
async function readTextBounded(
  response: Response,
  signal: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return { text: text.slice(0, FILE_VIEWER_TEXT_MAX_BYTES), truncated: text.length > FILE_VIEWER_TEXT_MAX_BYTES };
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > FILE_VIEWER_TEXT_MAX_BYTES) {
        truncated = true;
        break;
      }
      chunks.push(new Uint8Array(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  let text = "";
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
  text += decoder.decode();
  return { text, truncated: truncated || text.length > FILE_VIEWER_TEXT_MAX_BYTES };
}

function FileViewerContent({ tab }: { tab: FileViewerTab }) {
  const [state, setState] = useState<ContentState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState(false);
  const previewKind = filePreviewKind(tab.path);
  const renders = previewKind === "markdown" || previewKind === "html";

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void (async () => {
      try {
        const response = await requestMessageFile(
          tab.path,
          { threadId: tab.threadId, messageId: tab.messageId },
          controller.signal,
        );
        const mimeHeader = response.headers.get("content-type");
        const declared = Number(response.headers.get("content-length"));
        const bytes = Number.isFinite(declared) && declared >= 0 ? declared : null;
        const kind = fileViewerKind(mimeHeader, tab.path || tab.name);
        if (kind === "text") {
          const { text, truncated } = await readTextBounded(response, controller.signal);
          if (controller.signal.aborted) return;
          setState({
            status: "ready",
            content: { kind, text, truncated: truncated || textPreviewExceeds(bytes), mime: mimeHeader, bytes },
          });
          return;
        }
        if (kind === "image" || kind === "pdf") {
          const blob = await response.blob();
          if (controller.signal.aborted) return;
          setState({
            status: "ready",
            content: { kind, blobUrl: URL.createObjectURL(blob), mime: blob.type || mimeHeader, bytes: blob.size },
          });
          return;
        }
        await response.body?.cancel();
        setState({ status: "ready", content: { kind, mime: mimeHeader, bytes } });
      } catch (error) {
        if (!controller.signal.aborted) {
          setState({ status: "failed", message: error instanceof Error ? error.message : t("attach.viewer.failed") });
        }
      }
    })();
    return () => controller.abort();
  }, [tab, attempt]);

  const blobUrl = state.status === "ready" ? state.content.blobUrl : undefined;
  useEffect(() => {
    if (!blobUrl) return;
    return () => URL.revokeObjectURL(blobUrl);
  }, [blobUrl]);

  if (state.status === "loading") {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-ink-secondary" role="status">
        <LoaderCircle size={20} className="animate-spin" />
        <span className="text-[12.5px]">{t("attach.viewer.loading", { name: tab.name })}</span>
      </div>
    );
  }
  if (state.status === "failed") {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-ink-secondary" role="alert">
        <TriangleAlert size={26} className="text-danger" />
        <span className="max-w-[36ch] text-center text-[12.5px]">{state.message}</span>
        <button
          type="button"
          onClick={() => setAttempt((value) => value + 1)}
          className="flex items-center gap-1.5 rounded-lg border border-hairline/50 bg-panel px-3 py-1.5 text-[12px] text-ink hover:bg-raised"
        >
          <RotateCcw size={13} /> {t("chat.retry")}
        </button>
      </div>
    );
  }

  const { content } = state;
  if (content.kind === "text") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {content.truncated && (
          <div className="shrink-0 border-b border-hairline/30 bg-raised/50 px-4 py-1.5 text-[11px] text-ink-secondary">
            {t("attach.viewer.truncated")}
          </div>
        )}
        {renders && <div className="shrink-0 border-b border-hairline/30 px-4 py-2">
          <button type="button" aria-pressed={source} onClick={() => setSource((shown) => !shown)}
            className="rounded-md px-2 py-1 text-[12px] text-accent hover:bg-raised">
            {t(source ? "attach.viewer.showRendered" : "attach.viewer.showSource")}
          </button>
        </div>}
        {!source && previewKind === "html" && !content.truncated
          ? <iframe title={tab.name} sandbox="allow-scripts" srcDoc={sandboxedHtml(content.text ?? "")} className="min-h-0 flex-1 border-0 bg-white" />
          : !source && previewKind === "markdown"
          ? <div className="min-h-0 flex-1 overflow-auto p-4"><ChatMarkdown>{content.text ?? ""}</ChatMarkdown></div>
          : <div dir="ltr" className="min-h-0 flex-1 overflow-auto p-4"><CodeBlock lang={fileLanguage(tab.path)} code={content.text ?? ""} /></div>}
      </div>
    );
  }
  if (content.kind === "image" && content.blobUrl) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        <img src={content.blobUrl} alt={tab.name} className="max-h-full max-w-full rounded-lg object-contain shadow-lg" />
      </div>
    );
  }
  if (content.kind === "pdf" && content.blobUrl) {
    return <iframe src={content.blobUrl} title={tab.name} className="min-h-0 flex-1 border-0 bg-white" />;
  }
  if (content.kind === "video" && content.blobUrl) {
    return <div className="flex min-h-0 flex-1 items-center justify-center p-4"><video controls preload="metadata" src={content.blobUrl} aria-label={tab.name} className="max-h-full max-w-full" /></div>;
  }
  if (content.kind === "audio" && content.blobUrl) {
    return <div className="flex min-h-0 flex-1 items-center justify-center p-4"><audio controls preload="metadata" src={content.blobUrl} aria-label={tab.name} /></div>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-ink-secondary">
      <Files size={26} />
      <span className="text-[13px] font-medium text-ink">{tab.name}</span>
      <span className="text-[11.5px]">
        {[content.mime, formatByteSize(content.bytes)].filter(Boolean).join(" · ")}
      </span>
      <span className="max-w-[40ch] text-[12px]">{t("attach.viewer.unsupported")}</span>
    </div>
  );
}

function ViewerSaveButton({ tab }: { tab: FileViewerTab }) {
  const save = useLocalFileSave(tab.path, tab.name, { threadId: tab.threadId, messageId: tab.messageId });
  return (
    <button
      type="button"
      onClick={() => void save.save()}
      disabled={save.state === "saving"}
      aria-label={t("attach.viewer.saveAria", { name: tab.name })}
      title={t("attach.viewer.saveAria", { name: tab.name })}
      className={cn(
        "flex size-8 items-center justify-center rounded-lg text-ink-secondary transition-colors hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
        save.state === "failed" && "text-danger",
        save.state === "saved" && "text-success",
      )}
    >
      {save.state === "saving" ? (
        <LoaderCircle size={15} className="animate-spin" />
      ) : save.state === "saved" ? (
        <Check size={15} />
      ) : save.state === "failed" ? (
        <RotateCcw size={15} />
      ) : (
        <Download size={15} />
      )}
    </button>
  );
}

export function FileViewerPanel() {
  const { state, dispatch } = useStore();
  const { padClass } = useCaptionChrome();
  const tabs = state.fileViewerTabs;
  const active = tabs.find((tab) => tab.id === state.fileViewerActiveTab) ?? null;

  const closePanel = useCallback(() => dispatch({ type: "toggleFileViewer", open: false }), [dispatch]);
  const closeTab = useCallback((id: string) => dispatch({ type: "closeFileViewerTab", id }), [dispatch]);

  const onTablistKeyDown = useCallback((event: ReactKeyboardEvent) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const tablist = event.currentTarget;
    const tabElements = [...tablist.querySelectorAll<HTMLElement>('[role="tab"]')];
    if (tabElements.length === 0) return;
    const current = tabElements.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowRight"
      ? (current + 1) % tabElements.length
      : (current + tabElements.length - 1) % tabElements.length;
    event.preventDefault();
    tabElements[next]!.focus();
    tabElements[next]!.click();
  }, []);

  return (
    <aside
      aria-label={t("attach.viewer.title")}
      className="animate-panel-in absolute inset-0 z-40 flex h-full min-w-0 flex-col border-l border-hairline/40 bg-panel md:static md:z-auto md:w-[min(560px,55vw)] md:shrink-0"
    >
      <div className={cn("flex shrink-0 items-center justify-between gap-2 px-4 py-3", padClass)}>
        <span className="flex min-w-0 items-center gap-2 text-[15px] font-semibold text-ink">
          <Files size={16} className="shrink-0 text-ink-secondary" />
          <span className="truncate">{t("attach.viewer.title")}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {active && <ViewerSaveButton key={active.id} tab={active} />}
          <button
            type="button"
            onClick={closePanel}
            aria-label={t("attach.viewer.closeAria")}
            title={t("attach.viewer.closeAria")}
            className="flex size-8 items-center justify-center rounded-lg text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
          >
            <X size={17} />
          </button>
        </span>
      </div>

      {tabs.length > 0 && (
        <div
          role="tablist"
          aria-label={t("attach.viewer.tabs")}
          onKeyDown={onTablistKeyDown}
          className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-hairline/40 px-2 pb-2"
        >
          {tabs.map((tab) => {
            const selected = tab.id === active?.id;
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                title={tab.name}
                onClick={() => dispatch({ type: "setFileViewerTab", id: tab.id })}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    dispatch({ type: "setFileViewerTab", id: tab.id });
                  }
                }}
                className={cn(
                  "flex min-w-0 max-w-[220px] shrink-0 cursor-pointer items-center gap-1 rounded-lg border px-2 py-1 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                  selected
                    ? "border-hairline/50 bg-raised text-ink"
                    : "border-transparent text-ink-secondary hover:bg-raised/60 hover:text-ink",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{tab.name}</span>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab.id);
                  }}
                  aria-label={t("attach.viewer.closeTabAria", { name: tab.name })}
                  className="flex size-5 shrink-0 items-center justify-center rounded text-ink-secondary hover:bg-panel hover:text-ink"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {active ? (
        <FileViewerContent key={active.id} tab={active} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-ink-secondary">
          <Files size={26} />
          <span className="max-w-[44ch] text-[12.5px]">{t("attach.viewer.empty")}</span>
        </div>
      )}
    </aside>
  );
}

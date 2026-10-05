// A file a message shares, opened beside the chat: Markdown rendered, an
// HTML page drawn in a sandbox, images, PDFs and media in their players, and
// code or data as highlighted text. The bytes come through the same
// message-scoped route as a download, so the server re-checks the grant.
import { useEffect, useState } from "react";
import { Check, Code2, Download, Eye, FileText, LoaderCircle, RotateCcw, X } from "lucide-react";
import { useStore, type FilePreview } from "@/state/store";
import { cn } from "@/lib/cn";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { requestMessageFile, useLocalFileSave } from "@/components/AttachmentPreview";
import { ChatMarkdown, CodeBlock } from "@/components/ChatMarkdown";
import { fileLanguage, filePreviewKind, sandboxedHtml } from "@/lib/file-preview";

// Text past this is shown cut, with the download for the rest.
const TEXT_LIMIT = 2 * 1024 * 1024;

type Loaded =
  | { state: "loading" }
  | { state: "failed"; reason: string }
  | { state: "text"; text: string; truncated: boolean }
  | { state: "blob"; url: string };

function useFileContents(file: FilePreview, mode: "text" | "blob" | null): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const asText = mode === "text";
  useEffect(() => {
    // A file with no preview is never read; its download fetches it once.
    if (mode === null) return;
    const controller = new AbortController();
    let url: string | null = null;
    setLoaded({ state: "loading" });
    requestMessageFile(file.path, file.message, controller.signal)
      .then(async (response) => {
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        if (asText) {
          const truncated = blob.size > TEXT_LIMIT;
          const text = await (truncated ? blob.slice(0, TEXT_LIMIT) : blob).text();
          if (!controller.signal.aborted) setLoaded({ state: "text", text, truncated });
          return;
        }
        url = URL.createObjectURL(blob);
        setLoaded({ state: "blob", url });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoaded({ state: "failed", reason: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.path, file.message.threadId, file.message.messageId, mode, asText]);
  return loaded;
}

export function FilePreviewPanel({ file }: { file: FilePreview }) {
  const { dispatch } = useStore();
  const { padClass } = useCaptionChrome();
  const kind = filePreviewKind(file.name || file.path);
  const renders = kind === "markdown" || kind === "html";
  const [source, setSource] = useState(false);
  useEffect(() => setSource(false), [file.path]);
  const loaded = useFileContents(file, kind === "none" ? null : renders || kind === "text" ? "text" : "blob");
  const save = useLocalFileSave(file.path, file.name, file.message);

  return (
    <aside
      aria-label={`Preview of ${file.name}`}
      className="animate-panel-in flex h-full w-[min(680px,44vw)] min-w-[360px] max-w-full shrink-0 flex-col border-l border-hairline/40 bg-panel max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-30 max-md:w-full max-md:min-w-0"
    >
      <div className={cn("flex items-center gap-2 border-b border-hairline/40 px-4 py-3", padClass)}>
        <FileText size={16} className="shrink-0 text-ink-secondary" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink" title={file.path}>{file.name}</span>
        {renders && (
          <button
            type="button"
            onClick={() => setSource((shown) => !shown)}
            aria-pressed={source}
            title={source ? "Show the rendered file" : "Show the source"}
            aria-label={source ? "Show the rendered file" : "Show the source"}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            {source ? <Eye size={15} /> : <Code2 size={15} />}
          </button>
        )}
        <button
          type="button"
          onClick={() => void save.save()}
          disabled={save.state === "saving"}
          title={save.state === "failed" ? save.reason : save.state === "saved" ? `Saved to ${save.savedTo}` : "Download"}
          aria-label={`Download ${file.name}`}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink disabled:cursor-wait"
        >
          {save.state === "saving" ? <LoaderCircle size={15} className="animate-spin" />
            : save.state === "saved" ? <Check size={15} className="text-success" />
              : save.state === "failed" ? <RotateCcw size={15} className="text-danger" />
                : <Download size={15} />}
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: "closeFilePreview" })}
          aria-label="Close preview"
          title="Close preview"
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <PreviewBody file={file} kind={kind} loaded={loaded} source={source} onDownload={() => void save.save()} />
      </div>
    </aside>
  );
}

function PreviewBody({ file, kind, loaded, source, onDownload }: {
  file: FilePreview;
  kind: ReturnType<typeof filePreviewKind>;
  loaded: Loaded;
  source: boolean;
  onDownload: () => void;
}) {
  if (kind === "none") {
    return (
      <div className="flex flex-col items-start gap-3 px-4 py-6 text-[13px] text-ink-secondary">
        <span>There&apos;s no preview for this kind of file.</span>
        <button type="button" onClick={onDownload} className="inline-flex items-center gap-1.5 rounded-md border border-hairline/50 px-2.5 py-1.5 text-ink hover:bg-raised">
          <Download size={14} /> Download
        </button>
      </div>
    );
  }
  if (loaded.state === "loading") {
    return <div className="flex items-center gap-2 px-4 py-6 text-[13px] text-ink-secondary"><LoaderCircle size={14} className="animate-spin" /> Loading…</div>;
  }
  if (loaded.state === "failed") {
    return <div role="alert" className="px-4 py-6 text-[13px] text-danger">Couldn&apos;t open this file: {loaded.reason}</div>;
  }
  if (loaded.state === "text") {
    const cut = loaded.truncated && (
      <p className="px-4 pb-4 text-[12px] text-ink-secondary">Showing the first 2 MB. Download the file for the rest.</p>
    );
    if (kind === "html" && !source) {
      return (
        <iframe
          title={file.name}
          // Scripts run so charts draw, but in an opaque origin: no access to
          // this app, its storage or its cookies, and no top navigation.
          sandbox="allow-scripts allow-popups"
          srcDoc={sandboxedHtml(loaded.text)}
          className="block h-full w-full border-0 bg-white"
        />
      );
    }
    if (kind === "markdown" && !source) {
      return <div className="px-5 py-4 text-[14px] leading-relaxed text-ink"><ChatMarkdown text={loaded.text} />{cut}</div>;
    }
    return (
      <div className="p-3">
        <CodeBlock code={loaded.text} lang={kind === "markdown" ? "md" : kind === "html" ? "html" : fileLanguage(file.name)} />
        {cut}
      </div>
    );
  }
  switch (kind) {
    case "image":
      return <div className="flex min-h-full items-center justify-center p-4"><img src={loaded.url} alt={file.name} className="max-h-full max-w-full object-contain" /></div>;
    case "pdf":
      return <iframe title={file.name} src={loaded.url} className="block h-full w-full border-0" />;
    case "video":
      return <div className="p-4"><video src={loaded.url} controls className="w-full rounded-lg" /></div>;
    case "audio":
      return <div className="p-4"><audio src={loaded.url} controls className="w-full" /></div>;
    default:
      return null;
  }
}

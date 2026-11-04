import { useEffect, useRef, useState } from "react";
import { Eye, LoaderCircle } from "lucide-react";
import { t } from "@/lib/i18n";
import { requestMessageFile, type MessageAttachmentContext } from "./AttachmentPreview";
import type { FilePreviewButtonProps } from "./FilePreviewButton";
import { TableDialog } from "./RichTable";
import { readTableResponse } from "./TableFilePreview";

export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

type TextPreviewState = { kind: "loading" } | { kind: "ready"; text: string } | { kind: "error"; reason: "size" | "load" };

export function TextFileButton({ path, name, message, children, className }: FilePreviewButtonProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger} type="button" className={className ?? "table-action"} title={t("attach.previewAria", { name })} aria-label={t("attach.previewAria", { name })} onClick={() => setOpen(true)}>{children ?? <Eye size={14} />}</button>
    {open && <TableDialog title={name} returnFocus={trigger.current} onClose={() => setOpen(false)}><TextFileContent key={`${message.threadId}:${message.messageId}:${path}`} path={path} message={message} /></TableDialog>}
  </>;
}

function TextFileContent({ path, message }: { path: string; message: MessageAttachmentContext }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<TextPreviewState>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    void (async () => {
      try {
        const response = await requestMessageFile(path, message, controller.signal);
        const text = await readTableResponse(response, controller.signal, TEXT_PREVIEW_MAX_BYTES);
        if (!controller.signal.aborted) setState({ kind: "ready", text });
      } catch (reason) {
        if (!controller.signal.aborted) setState({ kind: "error", reason: reason instanceof Error && reason.message === "size" ? "size" : "load" });
      }
    })();
    return () => controller.abort();
  }, [path, message.threadId, message.messageId, attempt]);

  if (state.kind === "loading") return <div role="status" className="flex items-center justify-center gap-2 p-12 text-sm text-ink-secondary"><LoaderCircle size={16} className="animate-spin" />{t("attach.textLoading")}</div>;
  if (state.kind === "error") return <div className="p-8 text-center text-sm">
    <p role="alert" className="mb-3 text-ink-secondary">{t(state.reason === "size" ? "attach.textTooLarge" : "attach.textLoadFailed")}</p>
    <button type="button" className="min-h-11 rounded-lg border border-hairline px-3 py-2 hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60" onClick={() => setAttempt(attempt + 1)}>{t("chat.retry")}</button>
  </div>;
  return state.text
    // The dialog is sized for a wide table; prose wrapped at its full width is past a readable line length.
    ? <pre dir="auto" className="mx-auto max-h-[72dvh] w-full max-w-[92ch] overflow-auto rounded-lg border border-hairline/40 bg-inset p-4 text-[13px] leading-6 whitespace-pre-wrap break-words text-ink">{state.text}</pre>
    : <p className="p-8 text-center text-sm text-ink-secondary">{t("attach.textEmpty")}</p>;
}

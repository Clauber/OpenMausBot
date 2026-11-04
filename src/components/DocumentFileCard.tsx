import { Check, Code2, Download, File, FileArchive, FileText, Film, LoaderCircle, RotateCcw, Table2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { MessageFolderFiles, OutsideWorkspaceFile, saveFailureText, useLocalFileSave, type MessageAttachmentContext } from "./AttachmentPreview";
import { FilePreviewButton, filePreviewKind } from "./FilePreviewButton";

const FILE_ICONS: Partial<Record<string, typeof File>> = {
  csv: Table2, tsv: Table2, xls: Table2, xlsx: Table2,
  html: Code2, htm: Code2, json: Code2, xml: Code2,
  md: FileText, markdown: FileText, mdown: FileText, txt: FileText, pdf: FileText,
  zip: FileArchive, gz: FileArchive, tar: FileArchive,
  mp4: Film, mov: Film, webm: Film,
};

export function DocumentFileCard({ path, name, message, available = true, grouped = false }: {
  path: string;
  name: string;
  message?: MessageAttachmentContext;
  available?: boolean;
  /** Inside a shared container the card draws no rule of its own, the way a WhatsApp file list does. */
  grouped?: boolean;
}) {
  const save = useLocalFileSave(path, name, message);
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  const Icon = Object.hasOwn(FILE_ICONS, extension) ? FILE_ICONS[extension] ?? File : File;
  const preview = filePreviewKind(path, name);
  const accessibleMessage = available ? message : undefined;
  const failed = save.state === "failed";
  const saveLabel = t(failed && !save.outsideWorkspace ? "attach.retrySaveAria" : "attach.saveAria", { name });
  const targetClass = "flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2 text-start transition-colors hover:bg-raised/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 disabled:cursor-wait";
  const content = <>
    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-ink/[0.06] text-ink-secondary"><Icon size={21} aria-hidden="true" /></span>
    <span className="min-w-0 flex-1">
      <span dir="auto" className="block truncate text-[13px] font-medium leading-5 text-ink">{name}</span>
      <span className="block truncate text-[11px] leading-4 text-ink-secondary">{extension ? extension.toUpperCase() : t("attach.fileType")}{!accessibleMessage ? ` · ${t("attach.unavailable")}` : !preview ? ` · ${t("attach.saveOnly")}` : ""}</span>
    </span>
  </>;
  const saveIcon = save.state === "saving" ? <LoaderCircle size={17} className="animate-spin" />
    : save.state === "saved" ? <Check size={17} className="text-success" />
      : failed && !save.outsideWorkspace ? <RotateCcw size={17} /> : <Download size={17} />;

  return <span dir="ltr" className={cn(
    "flex w-full max-w-full flex-col overflow-hidden text-start align-middle [unicode-bidi:isolate]",
    // The card is a row, not a box: consecutive files read as one list instead of four framed panels.
    grouped ? "min-w-0" : "border-t border-hairline/30 first:border-t-0",
  )}>
    <span className="flex min-w-0 items-center">
      {!accessibleMessage ? <span title={t("attach.legacyFile", { name })} className={cn(targetClass, "hover:bg-transparent")}>{content}</span>
        : preview ? <>
          <FilePreviewButton path={path} name={name} message={accessibleMessage} className={targetClass}>{content}</FilePreviewButton>
          <button type="button" aria-label={saveLabel} title={t("attach.saveCopy")} onClick={() => void save.save()} disabled={save.state === "saving"} className="me-1 flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-secondary transition-colors hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 disabled:cursor-wait">{saveIcon}</button>
        </> : <button type="button" aria-label={saveLabel} title={t("attach.saveCopy")} onClick={() => void save.save()} disabled={save.state === "saving"} className={targetClass}>{content}<span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center text-ink-secondary">{saveIcon}</span></button>}
    </span>
    {save.state !== "idle" && <span role={failed ? "alert" : "status"} title={save.state === "saved" ? save.savedTo : undefined} className={cn("block border-t border-hairline/30 px-3 py-1.5 text-[12px]", failed ? "text-danger" : save.state === "saved" ? "text-success" : "text-ink-secondary")}>
      {failed ? saveFailureText(save) : t(save.state === "saving" ? "attach.downloading" : "attach.downloaded")}
      {failed && save.outsideWorkspace && <span className="mt-1 flex flex-wrap items-center gap-x-1.5"><OutsideWorkspaceFile filePath={path} /></span>}
    </span>}
    {save.folder && message && <MessageFolderFiles folderPath={path} listing={save.folder} message={message} />}
  </span>;
}

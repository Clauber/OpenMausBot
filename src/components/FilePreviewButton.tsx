import type { ReactNode } from "react";
import { tableDelimiter } from "@/lib/table-data";
import { TextFileButton } from "./TextFilePreview";
import type { MessageAttachmentContext } from "./AttachmentPreview";
import { HtmlFileButton, isHtmlFile } from "./HtmlFilePreview";
import { TableFileButton } from "./TableFilePreview";

export interface FilePreviewButtonProps {
  path: string;
  name: string;
  message: MessageAttachmentContext;
  children?: ReactNode;
  className?: string;
}

export function filePreviewKind(path: string, name: string): "html" | "table" | "text" | null {
  if (isHtmlFile(name) || isHtmlFile(path)) return "html";
  if (tableDelimiter(name) || tableDelimiter(path)) return "table";
  if (/\.(?:txt|md|markdown|mdown)$/i.test(name) || /\.(?:txt|md|markdown|mdown)$/i.test(path)) return "text";
  return null;
}

export function FilePreviewButton(props: FilePreviewButtonProps) {
  switch (filePreviewKind(props.path, props.name)) {
    case "html": return <HtmlFileButton {...props} />;
    case "table": return <TableFileButton {...props} />;
    case "text": return <TextFileButton {...props} />;
    case null: return null;
  }
}

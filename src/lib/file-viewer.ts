// Shared model for the file viewer panel: which files can be previewed
// inline, and the React context transcript chips and Markdown links use to
// open a tab. Classification mirrors the server's message-file MIME table;
// the server still re-checks every fetch, so this only picks a renderer.
import { createContext, useContext } from "react";

export interface FileViewerTab {
  /** Stable key: one tab per (thread, message, path). */
  id: string;
  /** The authored spelling from the message; the server owns the decode. */
  path: string;
  name: string;
  threadId: string;
  messageId: string;
}

export type FileViewerOpener = (tab: FileViewerTab) => void;

/** Null when no panel is mounted (bare test mounts, secondary windows):
 * callers keep their previous behavior, which is download-only. */
export const FileViewerContext = createContext<FileViewerOpener | null>(null);

export function useFileViewerOpener(): FileViewerOpener | null {
  return useContext(FileViewerContext);
}

export function fileViewerTabId(threadId: string, messageId: string, path: string): string {
  return `${threadId}\u0000${messageId}\u0000${path}`;
}

export type FileViewerKind = "text" | "image" | "pdf" | "video" | "audio" | "unsupported";

/** Text rendered as source even when a generic MIME hides the extension. */
const TEXT_VIEWER_EXTENSIONS = new Set([
  "bash", "c", "cc", "cfg", "conf", "cpp", "cs", "css", "csv", "cxx", "diff",
  "dockerfile", "env", "go", "gradle", "h", "hh", "hpp", "htm", "html", "ini",
  "java", "js", "json", "jsonc", "jsx", "kt", "kts", "log", "lua", "makefile",
  "md", "mjs", "patch", "php", "pl", "properties", "ps1", "py", "rb", "rs",
  "rst", "scss", "sh", "sql", "svg", "swift", "toml", "ts", "tsv", "tsx", "txt",
  "xml", "yaml", "yml", "zsh",
]);

const TEXT_VIEWER_MIMES = new Set([
  "application/json",
  "application/ld+json",
  "application/typescript",
  "application/javascript",
  "application/x-javascript",
  "application/xml",
  "application/xhtml+xml",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/sql",
  "application/x-sh",
  "image/svg+xml",
]);

const GENERIC_MIMES = new Set(["application/octet-stream", "application/x-binary", ""]);

export function fileViewerExtension(path: string): string {
  const name = path.split(/[\\/]/).at(-1) ?? "";
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  return extension;
}

/** The server's Content-Type decides first; the extension only breaks ties
 * when the MIME is generic. Anything else stays download-only. */
export function fileViewerKind(mime: string | null | undefined, path: string): FileViewerKind {
  const mediaType = (mime ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType.startsWith("text/")) return "text";
  if (TEXT_VIEWER_MIMES.has(mediaType)) return "text";
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  if (!GENERIC_MIMES.has(mediaType)) return "unsupported";
  const extension = fileViewerExtension(path);
  if (TEXT_VIEWER_EXTENSIONS.has(extension)) return "text";
  if (extension === "pdf") return "pdf";
  if (IMAGE_VIEWER_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_VIEWER_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_VIEWER_EXTENSIONS.has(extension)) return "audio";
  return "unsupported";
}

const IMAGE_VIEWER_EXTENSIONS = new Set(["avif", "bmp", "gif", "heic", "jpeg", "jpg", "png", "tif", "tiff", "webp"]);
const VIDEO_VIEWER_EXTENSIONS = new Set(["m4v", "mov", "mp4", "webm"]);
const AUDIO_VIEWER_EXTENSIONS = new Set(["aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav"]);

/** Text previews stay bounded: read at most one byte past the cap so a
 * truncated multi-byte character is dropped by the decoder, never mojibake. */
export const FILE_VIEWER_TEXT_MAX_BYTES = 1_000_000;

export function textPreviewExceeds(declaredBytes: number | null): boolean {
  return declaredBytes !== null && declaredBytes > FILE_VIEWER_TEXT_MAX_BYTES;
}

export function truncateTextPreview(text: string, maxChars = FILE_VIEWER_TEXT_MAX_BYTES): string {
  if (text.length <= maxChars) return text;
  // UTF-16 units, not bytes: the fetch layer caps bytes before decoding, so
  // this only guards a decoded string. Never leave a trailing lone surrogate.
  let end = maxChars;
  const tail = text.charCodeAt(end - 1);
  if (tail >= 0xd800 && tail <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

export function formatByteSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${unit}`;
}

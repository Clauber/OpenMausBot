// What the file preview panel can show, decided from the file's name. The
// opener context lets a transcript link hand its file to the panel without
// every link subscribing to the whole store.

export type FilePreviewKind = "markdown" | "html" | "image" | "pdf" | "video" | "audio" | "text" | "none";

const KINDS: Record<string, FilePreviewKind> = {
  md: "markdown", markdown: "markdown", mdx: "markdown",
  html: "html", htm: "html",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  pdf: "pdf",
  mp4: "video", m4v: "video", webm: "video", mov: "video",
  mp3: "audio", m4a: "audio", aac: "audio", wav: "audio", ogg: "audio", oga: "audio", opus: "audio", flac: "audio",
};

const TEXT = new Set([
  "txt", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "xml", "svg",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "cs",
  "php", "sh", "bash", "zsh", "ps1", "sql", "css", "scss", "vue", "svelte", "lua", "r", "diff", "patch",
]);

export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function filePreviewKind(name: string): FilePreviewKind {
  const ext = fileExtension(name);
  return KINDS[ext] ?? (TEXT.has(ext) ? "text" : "none");
}

/** Shiki's name for a text file's language; plain text when it has none. */
export function fileLanguage(name: string): string {
  const ext = fileExtension(name);
  const alias: Record<string, string> = { yml: "yaml", mjs: "js", cjs: "js", jsonl: "json", h: "c", log: "text", txt: "text", sh: "bash", zsh: "bash", svg: "xml" };
  return alias[ext] ?? (TEXT.has(ext) ? ext : "text");
}

// A bot-written page runs in an opaque-origin sandbox; the policy also keeps
// its scripts from calling out or submitting forms, so a page can draw its
// charts but cannot talk to this app's server with the person's session.
const HTML_POLICY = `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'">`;

/** The page with the policy placed before anything it could run. */
export function sandboxedHtml(source: string): string {
  // After <head>, else <html>, else the doctype: a policy ahead of the
  // doctype would drop the page into quirks mode.
  const anchor = /<head(?:\s[^>]*)?>/i.exec(source) ?? /<html(?:\s[^>]*)?>/i.exec(source) ?? /<!doctype[^>]*>/i.exec(source);
  if (!anchor) return HTML_POLICY + source;
  const at = anchor.index + anchor[0].length;
  return source.slice(0, at) + HTML_POLICY + source.slice(at);
}

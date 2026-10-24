import { ChevronRight, Download, FileText, Folder, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { Bot } from "@/state/store";
import { formatSize } from "@/lib/composer-attachments";
import { t } from "@/lib/i18n";
import { shortPath } from "@/lib/short-path";
import { cn } from "@/lib/cn";

interface Entry { name: string; bytes: number; mime: string }
interface Listing { roots: string[]; folders: string[]; entries: Entry[]; truncated: boolean }

const TEXT_PREVIEW_BYTES = 1024 * 1024;

function filesUrl(bot: Bot, root: number, path: string, raw = false): string {
  const query = new URLSearchParams({ threadId: bot.threadId, root: String(root), path });
  return `/api/bots/${encodeURIComponent(bot.id)}/files${raw ? "/raw" : ""}?${query}`;
}

function TextPreview({ src }: { src: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(src, { signal: controller.signal, cache: "no-store" })
      .then((response) => response.ok ? response.text() : Promise.reject(new Error(response.statusText)))
      .then(setText, () => { if (!controller.signal.aborted) setText(t("computer.files.noPreview")); });
    return () => controller.abort();
  }, [src]);
  return <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset p-3 font-mono text-[12px] text-ink">{text ?? "…"}</pre>;
}

function FileView({ entry, src }: { entry: Entry; src: string }) {
  const kind = entry.mime.split("/")[0];
  if (kind === "image") return <img src={src} alt={entry.name} className="max-h-[60vh] max-w-full rounded-lg object-contain" />;
  if (kind === "video") return <video src={src} controls className="max-h-[60vh] w-full rounded-lg bg-black" />;
  if (kind === "audio") return <audio src={src} controls className="w-full" />;
  if (entry.mime === "application/pdf") return <iframe src={src} title={entry.name} className="h-[60vh] w-full rounded-lg bg-white" />;
  if ((kind === "text" || entry.mime === "application/json") && entry.bytes <= TEXT_PREVIEW_BYTES) return <TextPreview src={src} />;
  return <p className="text-[12px] leading-5 text-ink-secondary">{t("computer.files.noPreview")}</p>;
}

/** The bot's folders for this conversation, read through the server so a remote app sees the same files. */
export function BotFolderBrowser({ bot, home }: { bot: Bot; home?: string }) {
  const [root, setRoot] = useState(0);
  const [path, setPath] = useState<string[]>([]);
  const [opened, setOpened] = useState<Entry | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setRoot(0);
    setPath([]);
    setOpened(null);
  }, [bot.id, bot.threadId]);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    fetch(filesUrl(bot, root, path.join("/")), { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as (Listing & { error?: string }) | null;
        if (!response.ok || !body) throw new Error(body?.error ?? response.statusText);
        setListing(body);
      })
      .catch((failure: Error) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [bot.id, bot.threadId, root, path.join("/"), reload]);

  const goTo = (depth: number) => {
    setPath(path.slice(0, depth));
    setOpened(null);
  };
  const crumb = "min-w-0 truncate rounded px-1 hover:bg-raised-hover";
  const row = "flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-ink hover:bg-raised-hover";
  const openedSrc = opened && filesUrl(bot, root, [...path, opened.name].join("/"), true);

  return (
    <div className="mt-3 rounded-xl bg-card p-4" data-testid="computer-folder-browser">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 text-[13px] font-medium text-ink">{t("computer.files.browse")}</div>
        <button type="button" onClick={() => setReload((value) => value + 1)} aria-label={t("computer.files.refresh")} title={t("computer.files.refresh")} className="shrink-0 rounded-lg p-1 text-ink-secondary hover:bg-raised-hover">
          <RefreshCw size={13} aria-hidden="true" />
        </button>
      </div>
      {listing && listing.roots.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label={t("computer.files.browse")}>
          {listing.roots.map((folder, index) => (
            <button
              key={folder}
              type="button"
              aria-pressed={index === root}
              onClick={() => { setRoot(index); goTo(0); }}
              className={cn("max-w-full truncate rounded-full px-2.5 py-0.5 font-mono text-[11px]", index === root ? "bg-control text-ink" : "text-ink-secondary hover:bg-raised-hover")}
              title={folder}
            >
              {shortPath(folder, home)}
            </button>
          ))}
        </div>
      )}
      <nav className="mt-2 flex min-w-0 flex-wrap items-center gap-0.5 text-[12px] text-ink-secondary" aria-label={t("computer.files.location")}>
        <button type="button" className={crumb} onClick={() => goTo(0)}>{listing ? shortPath(listing.roots[root] ?? "", home) : "…"}</button>
        {path.map((segment, index) => (
          <span key={index} className="flex min-w-0 items-center gap-0.5">
            <ChevronRight size={12} className="shrink-0" aria-hidden="true" />
            <button type="button" className={crumb} onClick={() => goTo(index + 1)}>{segment}</button>
          </span>
        ))}
        {opened && (
          <span className="flex min-w-0 items-center gap-0.5 text-ink">
            <ChevronRight size={12} className="shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate px-1" aria-current="page">{opened.name}</span>
          </span>
        )}
      </nav>
      {error ? (
        <p className="mt-2 text-[12px] leading-5 text-ink-secondary" role="alert">{t("computer.files.loadFailed", { error })}</p>
      ) : opened && openedSrc ? (
        <div className="mt-2 flex flex-col gap-2">
          <FileView entry={opened} src={openedSrc} />
          <a href={`${openedSrc}&download=1`} download={opened.name} className="flex w-fit items-center gap-1.5 rounded-lg bg-control px-2.5 py-1 text-[12px] text-ink hover:bg-raised-hover">
            <Download size={13} aria-hidden="true" />
            {t("computer.files.download")}
          </a>
        </div>
      ) : listing ? (
        <ul className="mt-2 flex flex-col">
          {listing.folders.map((name) => (
            <li key={`folder:${name}`}>
              <button type="button" className={row} onClick={() => setPath([...path, name])}>
                <Folder size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{name}</span>
              </button>
            </li>
          ))}
          {listing.entries.map((entry) => (
            <li key={`file:${entry.name}`}>
              <button type="button" className={row} onClick={() => setOpened(entry)}>
                <FileText size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <span className="shrink-0 text-[11px] text-ink-tertiary">{formatSize(entry.bytes)}</span>
              </button>
            </li>
          ))}
          {listing.folders.length === 0 && listing.entries.length === 0 && (
            <li className="px-2.5 py-1.5 text-[12px] text-ink-secondary">{t("computer.files.emptyFolder")}</li>
          )}
          {listing.truncated && <li className="px-2.5 py-1.5 text-[11px] text-ink-tertiary">{t("computer.files.truncated")}</li>}
        </ul>
      ) : null}
    </div>
  );
}

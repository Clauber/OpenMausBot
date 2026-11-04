// Security: model text never turns an arbitrary local path into a browser request; transcript paths resolve through
// attachmentImageUrl.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  ImageOff,
  LoaderCircle,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";

import {
  attachmentBasename,
  attachmentImageUrl,
  type TranscriptFileAttachment,
  type TranscriptImageAttachment,
} from "@/lib/composer-attachments";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { actualSizeScale, clampPan, clampScale, FIT_VIEW, pinchScale, zoomAt, type Point, type View } from "@/lib/pan-zoom";
import { FilePreviewButton } from "./FilePreviewButton";
import { ImageLoading } from "./ImageLoading";

export interface PreviewImage {
  src: string;
  name: string;
  downloadUrl?: string;
  downloadName?: string;
  openUrl?: string;
}

export interface MessageAttachmentContext { threadId: string; messageId: string }

export function previewImage(path: string, name = attachmentBasename(path)): PreviewImage | null {
  const src = attachmentImageUrl(path);
  if (!src) return null;
  return {
    src,
    name,
    downloadUrl: src,
    downloadName: canonicalDownloadFilename({ fallback: name, source: path }),
  };
}

export function wrappedImageIndex(index: number, step: -1 | 1, count: number): number {
  if (count <= 0) return 0;
  return (index + step + count) % count;
}

const OPAQUE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An attachment stored under a generated id has no name worth showing as a title. */
export function opaqueAttachmentName(name: string): boolean {
  const trimmed = name.trim();
  const stem = trimmed.replace(/\.[a-z0-9]+$/i, "");
  return OPAQUE_NAME.test(stem) || /^[0-9a-f]{32,}$/i.test(stem);
}

export type PreviewKeyAction = "close" | "previous" | "next" | "zoomIn" | "zoomOut" | "fit" | null;

export function previewKeyAction(key: string, count: number, zoomed: boolean): PreviewKeyAction {
  if (key === "Escape") return "close";
  if (key === "+" || key === "=") return "zoomIn";
  if (key === "-" || key === "_") return "zoomOut";
  if (key === "0") return "fit";
  if (count > 1 && !zoomed && key === "ArrowLeft") return "previous";
  if (count > 1 && !zoomed && key === "ArrowRight") return "next";
  return null;
}

export function imageGalleryLayout(count: number): string {
  if (count <= 1) return "w-[min(32rem,70vw)] grid-cols-1";
  if (count === 2) return "w-[min(36rem,70vw)] grid-cols-2";
  return "w-[min(38rem,70vw)] grid-cols-2 sm:grid-cols-3";
}

const IMAGE_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/tiff": "tiff",
  "image/webp": "webp",
};

const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "heic",
  "heif",
  "jpeg",
  "jpg",
  "png",
  "tif",
  "tiff",
  "webp",
]);

export function safeDownloadFilename(value: string | null | undefined): string {
  const basename = (value ?? "").split(/[\\/]/).at(-1) ?? "";
  const cleaned = basename
    .normalize("NFC")
    // oxlint-disable-next-line no-control-regex -- strips control and bidi characters from a filename
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .trim()
    .replace(/[. ]+$/g, "");
  const bounded = Array.from(cleaned)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return character.length > 1 || code < 0xd800 || code > 0xdfff;
    })
    .slice(0, 180)
    .join("");
  if (!bounded) return "download";
  const stem = bounded.split(".", 1)[0]!.toUpperCase();
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem) ? `_${bounded}` : bounded;
}

/** Prefers RFC 5987's UTF-8 filename* form. */
export function contentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const encoded = /(?:^|;)\s*filename\*\s*=\s*(?:UTF-8'[^']*')?([^;]*)/i.exec(header)?.[1]?.trim();
  if (encoded) {
    const unquoted = encoded.replace(/^"|"$/g, "");
    try {
      return safeDownloadFilename(decodeURIComponent(unquoted));
    } catch {
    }
  }
  const quoted = /(?:^|;)\s*filename\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(header)?.[1];
  if (quoted !== undefined) return safeDownloadFilename(quoted.replace(/\\(.)/g, "$1"));
  const plain = /(?:^|;)\s*filename\s*=\s*([^;]*)/i.exec(header)?.[1]?.trim();
  return plain ? safeDownloadFilename(plain) : null;
}

function sourceImageExtension(source: string | undefined): string | null {
  if (!source) return null;
  let pathname = source;
  try {
    pathname = decodeURIComponent(new URL(source, "https://openmausbot.invalid").pathname);
  } catch {
    pathname = source.split(/[?#]/, 1)[0] ?? source;
  }
  const extension = /\.([a-z0-9]+)$/i.exec(pathname)?.[1]?.toLowerCase();
  return extension && IMAGE_EXTENSIONS.has(extension) ? extension : null;
}

function replaceExtension(name: string, extension: string): string {
  const suffix = `.${extension}`;
  const stem = name.replace(/\.[^.]*$/, "") || "image";
  const available = Math.max(1, 180 - Array.from(suffix).length);
  return `${Array.from(stem).slice(0, available).join("")}${suffix}`;
}

export function canonicalDownloadFilename({
  contentDisposition,
  fallback,
  source,
  mime,
}: {
  contentDisposition?: string | null;
  fallback?: string;
  source?: string;
  mime?: string | null;
}): string {
  const selected = contentDispositionFilename(contentDisposition ?? null)
    ?? safeDownloadFilename(fallback);
  const mediaType = mime?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const imageExtension = IMAGE_EXTENSION_BY_MIME[mediaType] ?? sourceImageExtension(source);
  return imageExtension ? replaceExtension(selected, imageExtension) : selected;
}

export function isExternalImageSource(src: string): boolean {
  const value = src.trim();
  // The URL parser drops embedded ASCII tab/LF/CR and treats backslashes as slashes for special schemes.
  const networkSpelling = value.replace(/[\t\n\r]/g, "").replace(/\\/g, "/");
  // Chromium canonicalizes special-scheme variants (`https:host/x`, `https:/host/x`, backslashes) into network
  // requests.
  return networkSpelling.startsWith("//") || /^https?:/i.test(networkSpelling);
}

/**
 * Security: the host path never enters the browser URL; the server proves this message rendered an image at this source
 * offset.
 */
export function messageImagePreviewUrl(
  message: MessageAttachmentContext,
  sourceOffset: number,
): string {
  return `/api/threads/${encodeURIComponent(message.threadId)}/messages/${encodeURIComponent(message.messageId)}/file?preview=1&ref=${sourceOffset}`;
}

export async function messageImageOutsideWorkspace(src: string): Promise<boolean> {
  try {
    const response = await fetch(src, { cache: "no-store" });
    if (response.ok) {
      await response.body?.cancel();
      return false;
    }
    const body = await response.json().catch(() => null) as { code?: unknown } | null;
    return body?.code === "outside_workspace";
  } catch {
    return false;
  }
}

function revokeObjectUrlLater(url: string): void {
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Security: never request a transcript path directly, even when it looks like a URL. */
export async function requestMessageFile(
  filePath: string,
  message: MessageAttachmentContext,
  signal: AbortSignal,
  folder?: { entry?: string; list?: boolean },
): Promise<Response> {
  const response = await fetch(`/api/threads/${encodeURIComponent(message.threadId)}/messages/${encodeURIComponent(message.messageId)}/file`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: filePath,
      ...(folder?.entry !== undefined ? { entry: folder.entry } : folder?.list ? { listFolder: true } : {}),
    }),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; code?: string } | null;
    throw Object.assign(new Error(body?.error ?? t("attach.downloadFailed")), { code: body?.code });
  }
  return response;
}

export interface MessageFolderListing {
  name: string;
  entries: { name: string; bytes: number; mime: string }[];
  truncated: boolean;
}

export function useLocalFileSave(filePath: string, name?: string, message?: MessageAttachmentContext, entry?: string) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [folder, setFolder] = useState<MessageFolderListing | null>(null);
  const [reason, setReason] = useState("");
  const [savedTo, setSavedTo] = useState("");
  const [outsideWorkspace, setOutsideWorkspace] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  useEffect(() => {
    request.current?.abort();
    request.current = null;
    saving.current = false;
    setReason("");
    setSavedTo("");
    setOutsideWorkspace(false);
    setFolder(null);
    setState("idle");
  }, [filePath, entry, message?.messageId, message?.threadId]);

  const save = useCallback(async () => {
    if (saving.current) return;
    if (!message) {
      setReason(t("attach.unavailableOld"));
      setState("failed");
      return;
    }
    saving.current = true;
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
    setReason("");
    setOutsideWorkspace(false);
    setState("saving");
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await requestMessageFile(filePath, message, controller.signal, entry === undefined ? { list: true } : { entry });
      if (response.headers.get("x-openmausbot-folder") === "1") {
        const listing = await response.json() as MessageFolderListing;
        if (!mounted.current || controller.signal.aborted) return;
        setFolder(listing);
        setState("idle");
        return;
      }
      const blob = await response.blob();
      if (!mounted.current || controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const saved = canonicalDownloadFilename({
        contentDisposition: response.headers.get("content-disposition"),
        fallback: name || entry || attachmentBasename(filePath),
        source: filePath,
        mime: blob.type || response.headers.get("content-type"),
      });
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = saved;
        link.style.display = "none";
        document.body.append(link);
        try {
          link.click();
        } finally {
          link.remove();
        }
      } finally {
        // Chromium may not consume a blob URL until after the click task ends.
        revokeObjectUrlLater(url);
      }
      if (!mounted.current || controller.signal.aborted) return;
      setSavedTo(saved);
      setState("saved");
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => {
        if (mounted.current) setState("idle");
      }, 4000);
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      setReason(error instanceof Error ? error.message : t("attach.saveFailed"));
      setOutsideWorkspace((error as { code?: unknown } | null)?.code === "outside_workspace");
      setState("failed");
    } finally {
      if (request.current === controller) {
        request.current = null;
        saving.current = false;
      }
    }
  }, [filePath, entry, message?.messageId, message?.threadId, name]);

  return { state, reason, savedTo, outsideWorkspace, folder, save };
}

export function saveFailureText(save: { reason: string; outsideWorkspace: boolean }): string {
  return save.outsideWorkspace ? t("attach.outsideWorkspace") : save.reason;
}

function folderFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`;
}

function MessageFolderFile({ folderPath, name, bytes, message }: {
  folderPath: string;
  name: string;
  bytes: number;
  message: MessageAttachmentContext;
}) {
  const save = useLocalFileSave(folderPath, name, message, name);
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-1.5">
      <button
        type="button"
        onClick={() => void save.save()}
        disabled={save.state === "saving"}
        aria-label={t("attach.saveAria", { name })}
        className="inline-flex min-h-8 min-w-0 items-center gap-1 break-all text-start text-accent underline decoration-accent/40 hover:decoration-accent disabled:cursor-wait"
      >
        {save.state === "saving" ? (
          <LoaderCircle size={12} className="shrink-0 animate-spin" aria-hidden="true" />
        ) : save.state === "saved" ? (
          <Check size={12} className="shrink-0 text-success" aria-hidden="true" />
        ) : (
          <FileText size={12} className="shrink-0" aria-hidden="true" />
        )}
        {name}
      </button>
      <span className="text-ink-secondary">{folderFileSize(bytes)}</span>
      {save.state === "failed" && <span role="alert" className="text-danger">{save.reason}</span>}
    </li>
  );
}

export function MessageFolderFiles({ folderPath, listing, message }: {
  folderPath: string;
  listing: MessageFolderListing;
  message: MessageAttachmentContext;
}) {
  return (
    <span dir="ltr" className="block w-full text-[12px] [unicode-bidi:isolate]">
      {listing.entries.length === 0 ? (
        <span className="text-ink-secondary">{t("attach.folderEmpty")}</span>
      ) : (
        <ul aria-label={t("attach.folderFilesAria", { name: listing.name })} className="flex flex-col gap-0.5 ps-1">
          {listing.entries.map((entry) => (
            <MessageFolderFile key={entry.name} folderPath={folderPath} name={entry.name} bytes={entry.bytes} message={message} />
          ))}
        </ul>
      )}
      {listing.truncated && <span className="text-ink-secondary">{t("attach.folderTruncated")}</span>}
    </span>
  );
}

const REVEALABLE_PATH = /^(?:\/(?!\/)|[a-zA-Z]:[\\/])/;
function revealBridge(): NonNullable<Window["ogb"]>["revealInFolder"] {
  const ogb = typeof window === "undefined" ? undefined : window.ogb;
  return ogb?.remoteClient?.active ? undefined : ogb?.revealInFolder;
}

export function OutsideWorkspaceFile({ filePath }: { filePath: string }) {
  const [problem, setProblem] = useState("");
  const reveal = revealBridge();
  if (!reveal || !REVEALABLE_PATH.test(filePath)) {
    return (
      <code title={t("attach.outsideWorkspacePath")} className="select-all break-all text-ink">
        {filePath}
      </code>
    );
  }
  const show = async () => {
    setProblem("");
    try {
      const result = await reveal(filePath);
      if (result === "missing") setProblem(t("attach.revealMissing"));
      else if (result !== "shown") setProblem(t("attach.revealFailed"));
    } catch {
      setProblem(t("attach.revealFailed"));
    }
  };
  return (
    <>
      <button
        type="button"
        onClick={() => void show()}
        title={filePath}
        className="inline-flex items-center gap-1 text-accent underline decoration-accent/40 hover:decoration-accent"
      >
        <FolderOpen size={12} className="shrink-0" aria-hidden="true" />
        {t("attach.showInFolder")}
      </button>
      {problem && <span role="alert" className="text-danger">{problem}</span>}
    </>
  );
}

export function AttachmentPreviewDialog({
  image,
  images,
  initialIndex = 0,
  onClose,
}: {
  image: PreviewImage;
  images?: PreviewImage[];
  initialIndex?: number;
  onClose: () => void;
}) {
  const items = images?.length ? images : [image];
  const [index, setIndex] = useState(() => Math.min(Math.max(initialIndex, 0), items.length - 1));
  const current = items[index] ?? image;
  const dialogRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const naturalWidth = useRef(0);
  const closeRef = useRef(onClose);
  const [loadedSources, setLoadedSources] = useState<Set<string>>(() => new Set());
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState(FIT_VIEW);
  const [animate, setAnimate] = useState(false);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{ pointerId: number; start: Point; view: View; background: boolean; moved: boolean } | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<{ view: View; distance: number } | null>(null);
  const [fitRatio, setFitRatio] = useState(0);
  const loaded = loadedSources.has(current.src);
  const failed = failedSource === current.src;
  const zoomed = view.scale > 1;

  useLayoutEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    setView(FIT_VIEW);
    setAnimate(false);
    setDragging(false);
    setFitRatio(0);
    gesture.current = null;
    pinch.current = null;
    pointers.current.clear();
  }, [current.src, index, attempt, failed]);

  const measure = useCallback(() => {
    const layer = layerRef.current;
    const img = imageRef.current;
    if (!layer || !img || !img.naturalWidth) return null;
    // offsetWidth/offsetHeight ignore the CSS transform, so they are the object-contain size that scale 1 means.
    return {
      content: { width: img.offsetWidth, height: img.offsetHeight },
      viewport: layer.getBoundingClientRect(),
    };
  }, []);

  const pinchGrip = useCallback(() => {
    const [a, b] = [...pointers.current.values()];
    const layer = layerRef.current;
    if (!a || !b || !layer) return null;
    const box = layer.getBoundingClientRect();
    return {
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      center: { x: (a.x + b.x) / 2 - box.left - box.width / 2, y: (a.y + b.y) / 2 - box.top - box.height / 2 },
    };
  }, []);

  const syncFitRatio = useCallback(() => {
    const img = imageRef.current;
    setFitRatio(img && img.naturalWidth > 0 ? img.offsetWidth / img.naturalWidth : 0);
  }, []);

  const fit = useCallback(() => {
    setAnimate(true);
    setView(FIT_VIEW);
  }, []);

  const zoom = useCallback((factor: number) => {
    const sizes = measure();
    if (!sizes) return;
    setAnimate(true);
    setView((previous) => clampPan(
      zoomAt(previous, clampScale(previous.scale * factor), { x: 0, y: 0 }),
      sizes.content, sizes.viewport,
    ));
  }, [measure]);

  const navigate = useCallback((step: -1 | 1) => {
    setIndex((value) => wrappedImageIndex(value, step, items.length));
    setFailedSource(null);
  }, [items.length]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => previousFocus?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = previewKeyAction(event.key, items.length, zoomed);
      if (action) {
        event.preventDefault();
        event.stopPropagation();
        if (action === "close") closeRef.current();
        else if (action === "previous" || action === "next") navigate(action === "previous" ? -1 : 1);
        else if (action === "fit") fit();
        else if (loaded && !failed) zoom(action === "zoomIn" ? 1.4 : 1 / 1.4);
        return;
      }
      const directions: Record<string, Point> = {
        ArrowLeft: { x: 60, y: 0 }, ArrowRight: { x: -60, y: 0 },
        ArrowUp: { x: 0, y: 60 }, ArrowDown: { x: 0, y: -60 },
      };
      const direction = directions[event.key];
      if (zoomed && direction) {
        event.preventDefault();
        event.stopPropagation();
        const sizes = measure();
        if (sizes) {
          setAnimate(true);
          setView((previous) => clampPan({
            ...previous, x: previous.x + direction.x, y: previous.y + direction.y,
          }, sizes.content, sizes.viewport));
        }
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === dialog || document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items.length, navigate, zoomed, fit, zoom, measure, loaded, failed]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!loaded || failed || gesture.current) return;
      const sizes = measure();
      if (!sizes) return;
      const point = {
        x: event.clientX - sizes.viewport.left - sizes.viewport.width / 2,
        y: event.clientY - sizes.viewport.top - sizes.viewport.height / 2,
      };
      setAnimate(false);
      setView((previous) => clampPan(
        zoomAt(previous, clampScale(previous.scale * Math.exp(-event.deltaY * 0.0025)), point),
        sizes.content, sizes.viewport,
      ));
    };
    layer.addEventListener("wheel", wheel, { passive: false });
    return () => layer.removeEventListener("wheel", wheel);
  }, [loaded, failed, measure]);

  useEffect(() => {
    const layer = layerRef.current;
    const img = imageRef.current;
    if (!layer || !img) return;
    const observer = new ResizeObserver(() => {
      syncFitRatio();
      const sizes = measure();
      if (sizes) setView((previous) => clampPan(previous, sizes.content, sizes.viewport));
    });
    observer.observe(layer);
    observer.observe(img);
    return () => observer.disconnect();
  }, [current.src, attempt, failed, measure, syncFitRatio]);

  const retry = () => {
    setFailedSource(null);
    setLoadedSources((sources) => {
      const next = new Set(sources);
      next.delete(current.src);
      return next;
    });
    setAttempt((value) => value + 1);
  };

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("attach.previewAria", { name: current.name })}
      tabIndex={-1}
      className="fixed inset-0 z-[70] overflow-hidden bg-black outline-none"
    >
      <div
        ref={layerRef}
        className={cn(
          "absolute inset-0 flex touch-none select-none items-center justify-center overflow-hidden",
          zoomed ? dragging ? "cursor-grabbing" : "cursor-grab" : "cursor-default",
        )}
        onPointerDown={(event) => {
          if (event.target !== imageRef.current && event.target !== event.currentTarget) return;
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (pointers.current.size === 2 && loaded && !failed) {
            const grip = pinchGrip();
            if (grip) {
              event.preventDefault();
              gesture.current = null;
              pinch.current = { view, distance: grip.distance };
              setDragging(false);
              setAnimate(false);
            }
            return;
          }
          if (pointers.current.size > 1 || event.button !== 0 || !event.isPrimary) return;
          gesture.current = {
            pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, view,
            background: event.target === event.currentTarget, moved: false,
          };
          if (zoomed) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            setAnimate(false);
            setDragging(true);
          }
        }}
        onPointerMove={(event) => {
          if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          const pinching = pinch.current;
          if (pinching) {
            const grip = pinchGrip();
            const sizes = measure();
            if (grip && sizes) {
              setView(clampPan(
                zoomAt(pinching.view, pinchScale(pinching.view.scale, pinching.distance, grip.distance), grip.center),
                sizes.content, sizes.viewport,
              ));
            }
            return;
          }
          const active = gesture.current;
          if (!active || active.pointerId !== event.pointerId) return;
          const dx = event.clientX - active.start.x;
          const dy = event.clientY - active.start.y;
          if (Math.hypot(dx, dy) >= 5) active.moved = true;
          if (active.view.scale <= 1) return;
          const sizes = measure();
          if (sizes) setView(clampPan({
            ...active.view, x: active.view.x + dx, y: active.view.y + dy,
          }, sizes.content, sizes.viewport));
        }}
        onPointerUp={(event) => {
          pointers.current.delete(event.pointerId);
          if (pointers.current.size < 2) pinch.current = null;
          const active = gesture.current;
          if (!active || active.pointerId !== event.pointerId) return;
          const background = document.elementFromPoint(event.clientX, event.clientY) === event.currentTarget;
          gesture.current = null;
          setDragging(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          if (active.background && background && !active.moved &&
            Math.hypot(event.clientX - active.start.x, event.clientY - active.start.y) < 5) onClose();
        }}
        onPointerCancel={(event) => {
          pointers.current.delete(event.pointerId);
          if (pointers.current.size < 2) pinch.current = null;
          gesture.current = null;
          setDragging(false);
        }}
        onLostPointerCapture={() => {
          gesture.current = null;
          setDragging(false);
        }}
        onDoubleClick={(event) => {
          if (!loaded || failed || document.elementFromPoint(event.clientX, event.clientY) !== imageRef.current) return;
          if (zoomed) { fit(); return; }
          const sizes = measure();
          if (!sizes) return;
          setAnimate(true);
          setView(clampPan(zoomAt(FIT_VIEW, actualSizeScale(naturalWidth.current, sizes.content.width), {
            x: event.clientX - sizes.viewport.left - sizes.viewport.width / 2,
            y: event.clientY - sizes.viewport.top - sizes.viewport.height / 2,
          }), sizes.content, sizes.viewport));
        }}
      >
        {!loaded && !failed && (
          <div className="pointer-events-none absolute inset-0 flex animate-pulse items-center justify-center bg-white/[0.055]" role="status">
            <span className="flex items-center gap-2 text-[13px] text-white/55">
              <LoaderCircle size={17} className="animate-spin" /> {t("attach.loadingImage")}
            </span>
          </div>
        )}
        {failed ? (
          <div className="flex flex-col items-center gap-3 text-white/60" role="alert">
            <ImageOff size={34} />
            <span className="text-[13px]">{t("attach.loadFailed")}</span>
            <button
              type="button"
              onClick={retry}
              className="flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/10 px-3 py-1.5 text-[12px] text-white hover:bg-white/15"
            >
              <RotateCcw size={13} /> {t("chat.retry")}
            </button>
          </div>
        ) : (
          <img
            ref={imageRef}
            key={`${current.src}:${attempt}`}
            src={current.src}
            alt={current.name}
            draggable={false}
            onLoad={(event) => {
              naturalWidth.current = event.currentTarget.naturalWidth;
              syncFitRatio();
              setLoadedSources((sources) => new Set(sources).add(current.src));
            }}
            onError={() => setFailedSource(current.src)}
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
              transition: animate ? "transform 150ms ease-out, opacity 150ms" : "opacity 150ms",
            }}
            className={cn("block max-h-full max-w-full object-contain", loaded ? "opacity-100" : "opacity-0")}
          />
        )}
      </div>
      <header className="absolute inset-x-0 top-0 z-20 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 bg-gradient-to-b from-black/90 via-black/60 to-transparent px-3 pb-10 pt-3 sm:px-4">
        <div className="min-w-0 flex-1 basis-40">
          <div className="truncate text-[13px] font-medium text-white">
            {opaqueAttachmentName(current.name) ? t("attach.untitledImage") : current.name}
          </div>
          <div className="text-[11px] text-white/70">
            {items.length > 1
              ? t("attach.position", { index: index + 1, count: items.length })
              : t("attach.imagePreview")}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {loaded && !failed && (
            <div className="flex shrink-0 items-center gap-0.5 rounded-xl border border-white/15 bg-black/40 p-1">
              <button className="flex size-8 items-center justify-center rounded-md text-white/75 hover:bg-white/10 hover:text-white" aria-label={t("canvas.zoomOut")} onClick={() => zoom(1 / 1.2)}><Minus size={15} /></button>
              <button className="min-w-12 rounded-md px-1 py-2 text-[11px] tabular-nums text-white/75 hover:bg-white/10 hover:text-white" aria-label={t("attach.fitImage")} title={t("attach.fitImageHint")} onClick={fit}>{Math.round(view.scale * (fitRatio || 1) * 100)}%</button>
              <button className="flex size-8 items-center justify-center rounded-md text-white/75 hover:bg-white/10 hover:text-white" aria-label={t("canvas.zoomIn")} onClick={() => zoom(1.2)}><Plus size={15} /></button>
            </div>
          )}
          {current.downloadUrl && (
            <a
              href={current.downloadUrl}
              download={current.downloadName ?? canonicalDownloadFilename({
                fallback: current.name,
                source: current.downloadUrl,
              })}
              className="flex size-9 items-center justify-center rounded-lg text-white/65 hover:bg-white/10 hover:text-white"
              aria-label={t("attach.downloadAria", { name: current.name })}
              title={t("attach.download")}
            >
              <Download size={17} />
            </a>
          )}
          {current.openUrl && (
            <a
              href={current.openUrl}
              target="_blank"
              rel="noreferrer"
              className="flex size-9 items-center justify-center rounded-lg text-white/65 hover:bg-white/10 hover:text-white"
              aria-label={t("attach.openOriginalAria", { name: current.name })}
              title={t("attach.openOriginal")}
            >
              <ExternalLink size={17} />
            </a>
          )}
          <button
            onClick={onClose}
            className="flex size-9 items-center justify-center rounded-lg text-white/65 hover:bg-white/10 hover:text-white"
            aria-label={t("attach.close")}
          >
            <X size={19} />
          </button>
        </div>
      </header>
      {items.length > 1 && (
        <>
          <button
            type="button"
            onClick={() => navigate(-1)}
            aria-label={t("attach.previous")}
            className="absolute left-2 top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white/80 hover:bg-black/75 hover:text-white sm:left-4"
          >
            <ChevronLeft size={21} />
          </button>
          <button
            type="button"
            onClick={() => navigate(1)}
            aria-label={t("attach.next")}
            className="absolute right-2 top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white/80 hover:bg-black/75 hover:text-white sm:right-4"
          >
            <ChevronRight size={21} />
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

export function AttachmentThumbnail({
  image,
  onPreview,
  className,
  eager = false,
  explainRefusal = false,
}: {
  image: PreviewImage;
  onPreview: () => void;
  className?: string;
  eager?: boolean;
  explainRefusal?: boolean;
}) {
  // Callers key this by src: resetting in an effect races a cached image's onLoad, which can fire before the effect
  // runs.
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);
  const [outsideWorkspace, setOutsideWorkspace] = useState(false);
  const [ratio, setRatio] = useState<number | null>(null);

  return (
    <span
      style={ratio ? { aspectRatio: String(ratio) } : undefined}
      className={cn("group/image relative block aspect-[4/3] min-w-0 overflow-hidden rounded-xl border border-hairline/40 bg-inset", className)}
    >
      {state === "loading" && <ImageLoading name={image.name} className="absolute inset-0 bg-raised/65" />}
      {state === "failed" ? (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center text-ink-secondary" role="alert">
          <ImageOff size={22} />
          {outsideWorkspace ? (
            <span className="max-w-full text-[12px]">{t("attach.imageOutsideWorkspace")}</span>
          ) : (
            <span className="max-w-full truncate text-[12px]">{t("attach.imageUnavailable")}</span>
          )}
          {!outsideWorkspace && <span
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setState("loading");
              setAttempt((value) => value + 1);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              setState("loading");
              setAttempt((value) => value + 1);
            }}
            className="flex items-center gap-1 rounded-md border border-hairline/50 bg-panel px-2 py-1 text-[11px] text-ink hover:bg-raised"
            aria-label={t("attach.retryAria", { name: image.name })}
          >
            <RotateCcw size={11} /> {t("chat.retry")}
          </span>}
        </span>
      ) : (
        <span
          role="button"
          tabIndex={state === "ready" ? 0 : -1}
          aria-disabled={state !== "ready"}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (state === "ready") onPreview();
          }}
          onKeyDown={(event) => {
            if (state === "ready" && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              onPreview();
            }
          }}
          className="absolute inset-0 block size-full cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 aria-disabled:cursor-default"
          aria-label={t("attach.previewImageAria", { name: image.name })}
          title={t("attach.previewAria", { name: image.name })}
        >
          <img
            key={`${image.src}:${attempt}`}
            src={image.src}
            alt={image.name}
            loading={eager ? "eager" : "lazy"}
            fetchPriority={eager ? "high" : undefined}
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget;
              if (naturalWidth > 0 && naturalHeight > 0) setRatio(Math.min(Math.max(naturalWidth / naturalHeight, 0.6), 2.4));
              setState("ready");
            }}
            onError={() => {
              setState("failed");
              if (explainRefusal) void messageImageOutsideWorkspace(image.src).then(setOutsideWorkspace);
            }}
            className={cn(
              "block size-full object-cover transition duration-200 group-hover/image:scale-[1.015]",
              state === "ready" ? "opacity-100" : "opacity-0",
            )}
          />
          <span className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover/image:opacity-100 group-focus-within/image:opacity-100">
            <Maximize2 size={13} />
          </span>
        </span>
      )}
    </span>
  );
}

export function AttachedImageGallery({
  paths,
  className,
  eager = false,
}: {
  paths: Array<string | TranscriptImageAttachment>;
  className?: string;
  eager?: boolean;
}) {
  const images = useMemo(() => paths.flatMap((reference) => {
    if (typeof reference !== "string" && !reference.private) return [];
    const path = typeof reference === "string" ? reference : reference.path;
    const name = typeof reference === "string" ? undefined : reference.name;
    const image = previewImage(path, name);
    return image ? [image] : [];
  }), [paths]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  if (images.length === 0) return null;
  return (
    <>
      <div className={cn("mb-2 grid max-w-full gap-2", imageGalleryLayout(images.length), className)}>
        {images.map((image, index) => (
          <AttachmentThumbnail key={`${image.src}:${index}`} image={image} onPreview={() => setSelectedIndex(index)} eager={eager} />
        ))}
      </div>
      {selectedIndex !== null && images[selectedIndex] && (
        <AttachmentPreviewDialog
          image={images[selectedIndex]}
          images={images}
          initialIndex={selectedIndex}
          onClose={() => setSelectedIndex(null)}
        />
      )}
    </>
  );
}

export function MarkdownImagePreview({
  src,
  name,
  openUrl,
  message,
  filePath,
  sourceOffset,
}: {
  src: string;
  name: string;
  openUrl?: string;
  message?: MessageAttachmentContext;
  filePath?: string;
  sourceOffset?: number;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const threadId = message?.threadId;
  const messageId = message?.messageId;
  const localSourceOffset = typeof sourceOffset === "number" && Number.isSafeInteger(sourceOffset) && sourceOffset >= 0
    ? sourceOffset
    : null;
  const localMessageImage = Boolean(
    filePath && threadId && messageId && localSourceOffset !== null,
  );
  const localImageKey = localMessageImage ? `${threadId}\u0000${messageId}\u0000${localSourceOffset}` : null;
  const [visibleLocalImageKey, setVisibleLocalImageKey] = useState<string | null>(null);
  const external = !filePath && isExternalImageSource(src);
  const [approvedExternalSource, setApprovedExternalSource] = useState<string | null>(null);

  useEffect(() => {
    if (!localImageKey) return;
    const element = containerRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisibleLocalImageKey(localImageKey);
      return;
    }
    setVisibleLocalImageKey(null);
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setVisibleLocalImageKey(localImageKey);
      observer.disconnect();
    }, { rootMargin: "320px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [localImageKey]);

  const shouldLoadLocalImage = localMessageImage && (visibleLocalImageKey === localImageKey || open);
  const externalAllowed = !external || approvedExternalSource === src;
  const visibleSource = externalAllowed
    ? localMessageImage
      ? shouldLoadLocalImage && filePath && threadId && messageId && localSourceOffset !== null
        ? messageImagePreviewUrl({ threadId, messageId }, localSourceOffset)
        : null
      : src
    : null;
  const image: PreviewImage = {
    src: visibleSource ?? "",
    name,
    openUrl,
    downloadUrl: localMessageImage ? visibleSource ?? undefined : undefined,
    downloadName: localMessageImage
      ? canonicalDownloadFilename({ fallback: name, source: filePath })
      : undefined,
  };
  return (
    <>
      <span ref={containerRef} className="my-2 block w-[min(36rem,70vw)] max-w-full">
        {external && !externalAllowed ? (
          <span className="flex aspect-[4/3] max-h-96 flex-col items-center justify-center gap-2 rounded-xl border border-hairline/40 bg-inset px-4 text-center text-[12px] text-ink-secondary">
            <ImageOff size={20} />
            <span>{t("attach.externalHidden")}</span>
            <button type="button" className="rounded-md border border-hairline/50 bg-panel px-2.5 py-1 text-ink hover:bg-raised" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setApprovedExternalSource(src); }}>{t("attach.loadImage")}</button>
          </span>
        ) : filePath && (!threadId || !messageId || localSourceOffset === null) ? (
          <span className="flex aspect-[4/3] max-h-96 items-center justify-center gap-2 rounded-xl border border-hairline/40 bg-inset text-[12px] text-ink-secondary" role="alert">
            <ImageOff size={17} /> {t("attach.oldImage")}
          </span>
        ) : visibleSource ? (
          <AttachmentThumbnail key={image.src} image={image} onPreview={() => setOpen(true)} className="max-h-96" eager explainRefusal={localMessageImage} />
        ) : (
          <ImageLoading name={name} className="aspect-[4/3] max-h-96 rounded-xl border border-hairline/40 bg-inset" />
        )}
        {openUrl && (
          <a href={openUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex text-[11px] text-accent hover:underline">
            {t("attach.openOriginal")}
          </a>
        )}
      </span>
      {open && visibleSource && <AttachmentPreviewDialog image={image} onClose={() => setOpen(false)} />}
    </>
  );
}

export function AttachedFileChip({ file, message, linked = false, compact = false, className }: {
  file: TranscriptFileAttachment;
  message?: MessageAttachmentContext;
  linked?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const save = useLocalFileSave(file.path, file.name, message);
  const failed = save.state === "failed";
  const retryable = failed && !save.outsideWorkspace;
  if (compact) return <CompactFileChip file={file} message={message} linked={linked} save={save} className={className} />;
  if (!message || (!file.private && !linked)) {
    return (
      <div title={t("attach.legacyFile", { name: file.name })} className={cn("flex max-w-[280px] items-center gap-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset/70 px-2.5 py-2 text-[12px] text-ink-secondary", className)}>
        <FileText size={14} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-ink">{file.name}</span>
        <span className="text-[11px]">{t("attach.unavailable")}</span>
      </div>
    );
  }
  return (
    <div
      title={save.state === "saved" && save.savedTo ? t("attach.savedTo", { path: save.savedTo }) : file.name}
      className={cn("max-w-[280px] overflow-hidden rounded-lg border border-hairline/40 bg-inset/70 text-[12px] text-ink-secondary", className)}
    >
      <div className="flex items-center pe-1">
        <button
          type="button"
          onClick={() => void save.save()}
          disabled={save.state === "saving"}
          aria-label={
            retryable
              ? t("attach.retrySaveAria", { name: file.name })
              : t("attach.saveAria", { name: file.name })
          }
          className="flex min-h-10 min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-raised/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 disabled:cursor-wait disabled:hover:bg-transparent"
        >
          <FileText size={14} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-ink">{file.name}</span>
          {save.state === "saving" ? (
            <LoaderCircle size={13} className="shrink-0 animate-spin" />
          ) : save.state === "saved" ? (
            <Check size={13} className="shrink-0 text-success" />
          ) : failed ? (
            retryable && <RotateCcw size={13} className="shrink-0 text-danger" />
          ) : (
            <Download size={13} className="shrink-0" />
          )}
        </button>
        <FilePreviewButton path={file.path} name={file.name} message={message} />
      </div>
      {save.state !== "idle" && (
        <div
          role={failed ? "alert" : "status"}
          className={cn(
            "border-t border-hairline/30 px-2.5 py-1.5 text-[11px]",
            failed ? "text-danger" : save.state === "saved" ? "text-success" : "text-ink-secondary",
          )}
        >
          {save.state === "saving"
            ? t("attach.downloading")
            : save.state === "saved"
              ? t("attach.downloaded")
              : saveFailureText(save)}
          {failed && save.outsideWorkspace && (
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5">
              <OutsideWorkspaceFile filePath={file.path} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const FILE_CHIP = "inline-flex h-7 max-w-[16rem] items-center rounded-full bg-ink/[0.06] text-[13px] leading-none text-ink-secondary";

function CompactFileChip({ file, message, linked, save, className }: {
  file: TranscriptFileAttachment;
  message?: MessageAttachmentContext;
  linked: boolean;
  save: ReturnType<typeof useLocalFileSave>;
  className?: string;
}) {
  const failed = save.state === "failed";
  const retryable = failed && !save.outsideWorkspace;
  const name = <span dir="auto" className="min-w-0 truncate text-ink [unicode-bidi:isolate]">{file.name}</span>;
  if (!message || (!file.private && !linked)) {
    return (
      <span title={t("attach.legacyFile", { name: file.name })} className={cn(FILE_CHIP, "gap-1.5 px-2.5", className)}>
        <FileText size={14} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
        {name}
        <span className="shrink-0 text-[12px]">{t("attach.unavailable")}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex max-w-full flex-col items-start gap-1">
      <span
        title={save.state === "saved" && save.savedTo ? t("attach.savedTo", { path: save.savedTo }) : file.name}
        className={cn(FILE_CHIP, "file-chip pe-0.5", className)}
      >
        <button
          type="button"
          onClick={() => void save.save()}
          disabled={save.state === "saving"}
          aria-label={retryable ? t("attach.retrySaveAria", { name: file.name }) : t("attach.saveAria", { name: file.name })}
          className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full ps-2.5 pe-2 transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-wait"
        >
          <FileText size={14} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
          {name}
          {save.state === "saving" ? (
            <LoaderCircle size={13} className="shrink-0 animate-spin" aria-hidden="true" />
          ) : save.state === "saved" ? (
            <Check size={13} className="shrink-0 text-success" aria-hidden="true" />
          ) : failed ? (
            retryable && <RotateCcw size={13} className="shrink-0 text-danger" aria-hidden="true" />
          ) : (
            <Download size={13} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
          )}
        </button>
        <FilePreviewButton path={file.path} name={file.name} message={message} />
      </span>
      {save.state !== "idle" && save.state !== "saved" && (
        <span role={failed ? "alert" : "status"} className={cn("px-2.5 text-[12px]", failed ? "text-danger" : "text-ink-secondary")}>
          {save.state === "saving" ? t("attach.downloading") : saveFailureText(save)}
          {failed && save.outsideWorkspace && (
            <span className="ms-1.5 inline-flex flex-wrap items-center gap-x-1.5"><OutsideWorkspaceFile filePath={file.path} /></span>
          )}
        </span>
      )}
      {save.state === "saved" && <span role="status" className="sr-only">{t("attach.downloaded")}</span>}
    </span>
  );
}

/** Security: transcript paths stay inert until the person asks the desktop shell to validate and save a copy. */
export function AttachedFileChips({ files, className, message }: { files: TranscriptFileAttachment[]; className?: string; message?: MessageAttachmentContext }) {
  if (files.length === 0) return null;
  return (
    <div className={cn("mb-2 flex max-w-full flex-wrap justify-end gap-1.5", className)}>
      {files.map((file, index) => (
        <AttachedFileChip key={`${file.path}:${index}`} file={file} message={message} />
      ))}
    </div>
  );
}

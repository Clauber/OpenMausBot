import { useCallback, useEffect, useRef, useState } from "react";

export type CopyResult = "copied" | "empty" | "failed";
export type CopyFeedback = "idle" | "copied" | "failed";

export const COPY_FEEDBACK_MS = 1200;

/** Bounds a web write that never settles; Chromium rejects an unfocused write at once. */
export const WEB_WRITE_TIMEOUT_MS = 3000;

function writeWeb(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), WEB_WRITE_TIMEOUT_MS);
    try {
      if (!navigator.clipboard?.writeText) return finish(false);
      Promise.resolve(navigator.clipboard.writeText(text)).then(() => finish(true), () => finish(false));
    } catch {
      finish(false);
    }
  });
}

/** The web Clipboard API rejects unfocused, denied and insecure-context writes; then the desktop bridge runs, then a
 * hidden-textarea execCommand("copy") for browsers without either. Never throws. */
export async function copyText(text: string): Promise<CopyResult> {
  if (!text.trim()) return "empty";
  if (await writeWeb(text)) return "copied";
  try {
    if (typeof window !== "undefined" && (await window.ogb?.copyText?.(text)) === true) return "copied";
  } catch {
  }
  return legacyCopy(text) ? "copied" : "failed";
}

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined" || !document.body || typeof document.execCommand !== "function") return false;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index)) : [];
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.tabIndex = -1;
  // Off-screen rather than display:none, which cannot be selected.
  area.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none";
  document.body.append(area);
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
    previous?.focus({ preventScroll: true });
  }
}

interface CopyFeedbackOptions {
  copy: (text: string) => Promise<CopyResult>;
  onChange: (state: CopyFeedback) => void;
  resetMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createCopyFeedback({
  copy,
  onChange,
  resetMs = COPY_FEEDBACK_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: CopyFeedbackOptions) {
  let pending = false;
  let disposed = false;
  let timer: unknown;

  const clear = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };

  return {
    async click(text: string): Promise<CopyResult | "busy"> {
      if (pending) return "busy";
      pending = true;
      let result: CopyResult;
      try {
        result = await copy(text);
      } catch {
        result = "failed";
      } finally {
        pending = false;
      }
      if (disposed || result === "empty") return result;
      clear();
      onChange(result === "copied" ? "copied" : "failed");
      timer = setTimer(() => {
        timer = undefined;
        onChange("idle");
      }, resetMs);
      return result;
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}

export function useCopyFeedback(text: string) {
  const [state, setState] = useState<CopyFeedback>("idle");
  const controller = useRef<ReturnType<typeof createCopyFeedback> | null>(null);
  useEffect(() => {
    const next = createCopyFeedback({ copy: copyText, onChange: setState });
    controller.current = next;
    return () => {
      next.dispose();
      controller.current = null;
    };
  }, []);
  const copy = useCallback(() => void controller.current?.click(text), [text]);
  return { state, copy };
}

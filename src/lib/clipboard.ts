// One way to put text on the clipboard, for every Copy button. The async
// Clipboard API is missing in insecure contexts and some webviews, and rejects
// when the page lacks clipboard-write permission or focus; either way the old
// call sites returned silently and the click looked dead. This tries the API,
// then a hidden-textarea execCommand("copy"), and tells the caller whether the
// text actually reached the clipboard so it can show success or an error.

/** Copy text; resolves true when a path succeeded, false when both failed. Never throws. */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* denied, unfocused or unavailable — try the legacy path */
    }
  }
  return legacyCopy(text);
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

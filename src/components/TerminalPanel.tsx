// The owner terminal: a VS Code-style bottom dock (Ctrl+`), running a shell
// on the server that serves this page. One WebSocket per panel; the server
// spawns a PTY when the socket opens and kills it when it closes, so closing
// the panel (or the tab) never leaks a shell. Binary frames are raw PTY
// output, text frames are JSON control — see server/routes/terminal.ts.
//
// Esc deliberately does not close this panel: the terminal needs it (vim,
// less). The close button and Ctrl+` are the only ways out.
import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCw, SquareTerminal, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";

type Status = "connecting" | "open" | "closed" | "blocked" | "unsupported";

const terminalOptions = {
  fontSize: 12.5,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  cursorBlink: true,
  scrollback: 2000,
  theme: { background: "#15171c", foreground: "#d6d9de", cursor: "#d6d9de" },
} as const;

export function TerminalPanel() {
  const { dispatch } = useStore();
  const hostRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [note, setNote] = useState<string>("");

  const connect = useCallback(() => {
    socketRef.current?.close();
    termRef.current?.dispose();
    observerRef.current?.disconnect();
    setStatus("connecting");
    setNote("");

    const term = new Terminal(terminalOptions);
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);

    const socket = new WebSocket(`${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/api/terminal`);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    const sendResize = () => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };
    socket.onopen = () => {
      setStatus("open");
      term.open(hostRef.current!);
      try { fit.fit(); } catch { /* zero-sized before layout settles */ }
      sendResize();
      term.onData((data) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data }));
      });
      term.onResize(sendResize);
      term.focus();
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const control = JSON.parse(event.data) as { type?: string; message?: string };
          if (control.type === "error" && control.message) term.writeln(`\x1b[31m${control.message}\x1b[0m`);
        } catch { /* only known control shapes print; the rest stays clean */ }
        return;
      }
      term.write(new Uint8Array(event.data as ArrayBuffer));
    };
    socket.onclose = (event) => {
      setStatus(event.code === 1000 ? "closed" : "blocked");
      setNote(event.code === 1000 ? t("terminal.disconnected") : t("terminal.refused", { reason: event.reason || `code ${event.code}` }));
    };

    // Follow the dock's size (window resizes, sidebar folding) so the shell's
    // rows/cols match what is on screen.
    const observer = new ResizeObserver(() => {
      if (!hostRef.current || socket.readyState !== WebSocket.OPEN) return;
      try { fit.fit(); } catch { /* collapsed to zero mid-transition */ }
    });
    if (hostRef.current) observer.observe(hostRef.current);
    observerRef.current = observer;
  }, []);

  // The probe runs once: the panel only makes sense when the server can host
  // a shell. A failed probe still opens the panel — the message inside says why.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/terminal", { headers: { accept: "application/json" } });
        if (cancelled) return;
        if (!res.ok) {
          const denied = res.status === 401 || res.status === 403;
          setStatus(denied ? "blocked" : "unsupported");
          setNote(t(denied ? "terminal.denied" : "terminal.unavailable"));
          return;
        }
        const probe = await res.json() as { available?: boolean };
        if (cancelled) return;
        if (!probe.available) {
          setStatus("unsupported");
          setNote(t("terminal.unavailable"));
          return;
        }
        connect();
      } catch {
        if (!cancelled) {
          setStatus("unsupported");
          setNote(t("terminal.unavailable"));
        }
      }
    })();
    return () => {
      cancelled = true;
      socketRef.current?.close();
      termRef.current?.dispose();
      observerRef.current?.disconnect();
    };
  }, [connect]);

  return (
    <section
      aria-label={t("terminal.title")}
      className="flex h-[38vh] min-h-[180px] shrink-0 flex-col border-t border-hairline bg-[#15171c] text-[#d6d9de]"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline/60 px-3">
        <SquareTerminal size={14} className="text-ink-secondary" />
        <span className="text-[12.5px] font-medium text-ink">{t("terminal.title")}</span>
        {status !== "open" && <span className="text-[12px] text-ink-secondary">{note || t("terminal.connecting")}</span>}
        <span className="flex-1" />
        {status === "closed" && (
          <button
            type="button"
            onClick={connect}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-white/10 hover:text-ink"
          >
            <RotateCw size={13} />
            {t("terminal.reconnect")}
          </button>
        )}
        <button
          type="button"
          aria-label={t("terminal.close")}
          onClick={() => dispatch({ type: "toggleTerminal", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-white/10 hover:text-ink"
        >
          <X size={15} />
        </button>
      </header>
      <div ref={hostRef} className="min-h-0 flex-1 p-1" />
    </section>
  );
}

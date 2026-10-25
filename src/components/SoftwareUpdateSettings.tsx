import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { Card } from "./SettingsPrimitives";
import { updateInProgress, type UpdatePlan, type UpdaterState } from "../../shared/updater";

export function SoftwareUpdateSettings() {
  const [state, setState] = useState<UpdaterState | null>(null);
  const [plan, setPlan] = useState<UpdatePlan | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const busy = state?.enabled && (state.busy || updateInProgress(state.lastApply?.status));
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const next = await api<UpdaterState>("/api/updater/state", { signal: controller.signal, timeoutMs: 3000 });
        if (mounted.current) { setState(next); setError(""); }
      } catch (cause) {
        // The server is temporarily unreachable during its own restart.
        if (mounted.current && !busy) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), busy ? 1000 : 10_000);
    return () => { mounted.current = false; controller.abort(); clearInterval(timer); };
  }, [busy]);
  const check = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setChecking(true); setError(""); setConfirm(false); setPlan(null);
    try {
      const next = await api<UpdatePlan | { enabled: false }>("/api/updater/plan", { timeoutMs: 125_000 });
      if (mounted.current) {
        if (next.enabled) setPlan(next);
        else setState(next);
      }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { inFlight.current = false; if (mounted.current) setChecking(false); }
  };
  const apply = async () => {
    if (inFlight.current || !plan?.target || !plan.sha256) return;
    inFlight.current = true; setError("");
    // Mark progress before the HTTP response; a fast service restart may cut it off.
    setState(previous => previous?.enabled ? { ...previous, busy: true } : previous);
    try {
      const next = await api<UpdaterState>("/api/updater/apply", { method: "POST", body: JSON.stringify({ target: plan.target, sha256: plan.sha256 }), timeoutMs: 20_000 });
      if (mounted.current) { setState(next); setConfirm(false); setPlan(null); }
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        try { setState(await api<UpdaterState>("/api/updater/state")); } catch { /* poll through restart */ }
      }
    } finally { inFlight.current = false; }
  };
  const button = "rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50";
  const result = state?.enabled ? state.lastApply : undefined;
  return <Card title="Software Update">
    {!state && !error && <p role="status">Loading update state…</p>}
    {state?.enabled === false && <p className="text-[13px] text-ink-secondary">Software updates are disabled. Configure a private update registry on this server to enable them.</p>}
    {state?.enabled && <div className="space-y-3 text-[13px]">
      <p>Version {state.current} · {state.channel} · {state.layout}</p>
      {state.runningTurns > 0 && <p className="text-ink-secondary">{state.runningTurns} active turns. Updating is allowed; restarting may interrupt them.</p>}
      <button className={button} disabled={checking || Boolean(busy)} onClick={() => void check()}>{checking ? "Checking and verifying…" : "Check for updates"}</button>
      {plan && <div className="space-y-2 rounded-lg border border-hairline p-3">
        {plan.target ? <>
          <p>{plan.current} → {plan.target} · {plan.size.toLocaleString()} bytes</p>
          <p className="break-all text-[11px] text-ink-secondary">Verified SHA-256: {plan.sha256}</p>
          {plan.changes && <pre className="whitespace-pre-wrap font-sans text-ink-secondary">{plan.changes}</pre>}
          <button className={button} disabled={Boolean(busy)} onClick={() => setConfirm(true)}>Apply update</button>
        </> : <p>Software is up to date.</p>}
      </div>}
      {confirm && plan?.target && <div role="alertdialog" aria-label="Confirm software update" aria-describedby="software-update-confirm" className="space-y-3 rounded-lg border border-accent-border bg-raised-hover p-3">
        <p id="software-update-confirm">Install {plan.target} and restart the server? Active turns may be interrupted. If the new version fails its health check, the previous version will be restored automatically.</p>
        <div className="flex gap-2">
          <button className={button} disabled={Boolean(busy)} onClick={() => void apply()}>Install and restart</button>
          <button className="rounded-lg border border-hairline px-3 py-2" disabled={Boolean(busy)} onClick={() => setConfirm(false)}>Cancel</button>
        </div>
      </div>}
      {busy && <p role="status">{result?.status === "rollback-failed" ? "Updates are locked until the installation is recovered." : `Updating: ${result?.status ?? "starting"}. Waiting for the server to return…`}</p>}
      {result && !updateInProgress(result.status) && <p role="status">
        {result.status === "applied" ? `Updated to ${result.current}. Health check passed.` : result.status === "rolled-back" ? `Update rolled back automatically to ${result.current}. ${result.message ?? ""}` : `${result.status}: ${result.message ?? ""}`}
      </p>}
    </div>}
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
  </Card>;
}

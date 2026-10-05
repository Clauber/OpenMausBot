// The Audit tab of the computer panel: what this bot did on its computer
// (tool, outcome, timing) with filters, plus an owner "Revoke access" that
// cancels whatever is running right now. The log never holds typed content.
import { useCallback, useEffect, useState } from "react";
import { api, type Bot } from "@/state/store";
import { t } from "@/lib/i18n";

export interface AuditRow {
  ts: number;
  computerId: string;
  botId: string;
  actor: "bot" | "owner";
  action: string;
  outcome: "ok" | "denied" | "error";
  durationMs: number;
  error?: string;
}

export function ComputerAuditPane({ bot }: { bot: Bot }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [outcome, setOutcome] = useState("");
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const query = new URLSearchParams({ botId: bot.id, limit: "200" });
    if (outcome) query.set("outcome", outcome);
    if (action) query.set("action", action);
    try {
      const data = await api<{ rows: AuditRow[] }>(`/api/computer-audit?${query}`);
      setRows(data.rows);
      setFailed(false);
    } catch { setFailed(true); }
  }, [bot.id, outcome, action]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const revoke = async () => {
    try {
      const { cancelled } = await api<{ cancelled: number }>("/api/computer-audit/revoke", {
        method: "POST", body: JSON.stringify({ botId: bot.id }),
      });
      setNotice(t("computer.audit.cancelled", { count: String(cancelled) }));
      void load();
    } catch { setNotice(t("computer.audit.revokeFailed")); }
  };

  const actions = [...new Set(rows.map((row) => row.action))].sort();
  const shown = actor ? rows.filter((row) => row.actor === actor) : rows;
  const select = "rounded-md border border-line bg-surface px-2 py-1 text-[12px] text-ink";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-4" data-testid="computer-audit">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label={t("computer.audit.filter.action")} className={select} value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">{t("computer.audit.filter.anyAction")}</option>
          {[...new Set([...actions, action].filter(Boolean))].map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <select aria-label={t("computer.audit.filter.outcome")} className={select} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          <option value="">{t("computer.audit.filter.anyOutcome")}</option>
          <option value="ok">ok</option>
          <option value="denied">denied</option>
          <option value="error">error</option>
        </select>
        <select aria-label={t("computer.audit.filter.actor")} className={select} value={actor} onChange={(e) => setActor(e.target.value)}>
          <option value="">{t("computer.audit.filter.anyActor")}</option>
          <option value="bot">bot</option>
          <option value="owner">owner</option>
        </select>
        <button type="button" onClick={revoke} data-testid="computer-audit-revoke"
          className="ml-auto rounded-md border border-danger/40 px-2 py-1 text-[12px] text-danger hover:bg-danger/10">
          {t("computer.audit.revoke")}
        </button>
      </div>
      {notice && <div role="status" data-testid="computer-audit-notice" className="rounded-md bg-inset px-3 py-2 text-[12px] text-ink">{notice}</div>}
      {failed && <div role="alert" className="text-[12px] text-danger">{t("computer.audit.loadFailed")}</div>}
      <p className="text-[11px] text-ink-secondary">{t("computer.audit.privacy")}</p>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-ink-secondary" data-testid="computer-audit-empty">{t("computer.audit.empty")}</p>
        ) : (
          <table className="w-full text-left text-[12px]">
            <thead className="text-ink-secondary">
              <tr><th className="py-1 pr-2 font-normal">{t("computer.audit.col.time")}</th><th className="pr-2 font-normal">{t("computer.audit.col.actor")}</th><th className="pr-2 font-normal">{t("computer.audit.col.action")}</th><th className="pr-2 font-normal">{t("computer.audit.col.outcome")}</th><th className="font-normal">{t("computer.audit.col.ms")}</th></tr>
            </thead>
            <tbody>
              {shown.map((row, index) => (
                <tr key={`${row.ts}-${index}`} className="border-t border-line align-top" data-testid="computer-audit-row">
                  <td className="py-1 pr-2 tabular-nums">{new Date(row.ts).toLocaleTimeString()}</td>
                  <td className="pr-2">{row.actor}</td>
                  <td className="pr-2 font-mono">{row.action}</td>
                  <td className={`pr-2 ${row.outcome === "ok" ? "text-success" : "text-danger"}`} title={row.error}>{row.outcome}{row.error ? ` · ${row.error}` : ""}</td>
                  <td className="tabular-nums">{row.durationMs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

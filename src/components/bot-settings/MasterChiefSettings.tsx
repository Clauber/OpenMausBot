import { useState } from "react";
import { api, useStore, type Bot } from "@/state/store";

interface AuditEntry {
  id: string; at: string; actorBotId: string | null; reason?: string; scope: string; status: string;
  changes: Array<{ targetId: string; resourceId?: string; name: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>;
}

export function MasterChiefSettings({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [target, setTarget] = useState("");
  const [actor, setActor] = useState("");
  const holder = state.config?.masterChiefOfStaffBotId;
  const active = holder === bot.id;
  const holderName = state.bots.find(candidate => candidate.id === holder)?.name ?? holder;
  async function assign() {
    setSaving(true); setError(null);
    try {
      const result = await api<{ botId: string | null }>("/api/fleet/master-chief", { method: "PUT", body: JSON.stringify({ botId: active ? null : bot.id }) });
      if (state.config) dispatch({ type: "configStatus", config: { ...state.config, masterChiefOfStaffBotId: result.botId } });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  }
  async function loadAudit() {
    setError(null);
    try { setEntries((await api<{ entries: AuditEntry[] }>("/api/fleet/audit")).entries.reverse()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return (
    <div className="mt-3 border-t border-hairline/40 pt-3">
      <div className="text-[13px] font-medium text-ink">Master Chief of Staff</div>
      <p className="mt-1 text-[13px] text-ink-secondary">
        {active ? `${bot.name} manages all LEGION bots autonomously, including General and other Chiefs.`
          : holder ? `${holderName} currently holds fleet authority. Promoting ${bot.name} transfers it.`
            : "Choose one Chief to manage all LEGION bots autonomously."}
        {" "}Execution permissions change only when explicitly requested. Deletion needs separate confirmation.
      </p>
      <button type="button" disabled={saving} onClick={() => void assign()}
        className="mt-2 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40">
        {saving ? "Saving…" : active ? "Revoke master authority" : "Promote to Master Chief of Staff"}
      </button>
      <button type="button" onClick={() => void loadAudit()} className="ml-3 text-[13px] text-ink underline">View fleet audit</button>
      {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
      {entries && <div className="mt-3">
        <label className="text-[13px] text-ink-secondary">Filter by bot
          <select aria-label="Filter fleet audit by bot" value={target} onChange={event => setTarget(event.target.value)}
            className="ml-2 rounded border border-hairline bg-inset p-1 text-ink">
            <option value="">All bots</option>
            {[...new Map(entries.flatMap(entry => entry.changes.map(change => [change.targetId, change.name] as const)))].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label className="mt-2 block text-[13px] text-ink-secondary">Filter by actor
          <select aria-label="Filter fleet audit by actor" value={actor} onChange={event => setActor(event.target.value)}
            className="ml-2 rounded border border-hairline bg-inset p-1 text-ink">
            <option value="">All actors</option>
            {[...new Set(entries.map(entry => entry.actorBotId ?? "owner-system"))].map(id =>
              <option key={id} value={id}>{id === "owner-system" ? "Owner / system" : state.bots.find(candidate => candidate.id === id)?.name ?? id}</option>)}
          </select>
        </label>
        <ul aria-label="Fleet audit" className="mt-2 max-h-72 overflow-y-auto text-[12px]">
          {entries.filter(entry => (!target || entry.changes.some(change => change.targetId === target)) && (!actor || (entry.actorBotId ?? "owner-system") === actor)).map(entry => <li key={entry.id} className="border-t border-hairline/40 py-2">
            <div>{new Date(entry.at).toLocaleString()} · {state.bots.find(candidate => candidate.id === entry.actorBotId)?.name ?? entry.actorBotId ?? "Owner / system"} · {entry.reason ?? entry.scope} · {entry.status}</div>
            {entry.changes.filter(change => !target || change.targetId === target).map(change => <details key={change.resourceId ?? change.targetId} className="mt-1">
              <summary className="cursor-pointer text-ink">{change.name} · {change.targetId}{change.after === null ? " · deleted" : ""}</summary>
              <pre className="mt-1 whitespace-pre-wrap break-all text-ink-secondary">{JSON.stringify({ before: change.before, after: change.after }, null, 2)}</pre>
            </details>)}
          </li>)}
          {!entries.length && <li>No fleet changes recorded.</li>}
        </ul>
      </div>}
    </div>
  );
}

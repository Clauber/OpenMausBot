import { useEffect, useState } from "react";
import type { TaughtListing } from "../../shared/taught-skills";
import { Card, Switch } from "./SettingsPrimitives";

export function TaughtSkillsCard({ botId, threadId }: { botId: string; threadId: string }) {
  const base = `/api/bots/${encodeURIComponent(botId)}/tasks/${encodeURIComponent(threadId)}/teach`;
  const [playbooks, setPlaybooks] = useState<TaughtListing[]>([]);
  const [alwaysAsk, setAlwaysAsk] = useState(false);
  const [compare, setCompare] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch(base); const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Could not load playbooks.");
        if (!cancelled) { setPlaybooks(body.playbooks ?? []); setAlwaysAsk(body.alwaysAsk); }
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load playbooks."); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [base]);
  const post = async (operation: string, payload: unknown) => {
    setWorking(true); setError(""); setMessage("");
    try {
      const response = await fetch(`${base}/${operation}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Replay failed.");
      if (operation === "settings") setAlwaysAsk(body.alwaysAsk);
      else setMessage(body.run.status === "awaiting-approval" ? "Review the skill approval card in this bot’s conversation. Approval starts this replay." : "Replay started. Run history will update.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Replay failed."); }
    finally { setWorking(false); }
  };
  return <Card title="Taught playbooks" subtitle="Computer demonstrations saved in the skill library. Approval applies separately to each bot.">
    <label className="mb-3 flex items-center justify-between gap-3 text-sm text-ink">Always ask before replay
      <Switch checked={alwaysAsk} disabled={working} onClick={() => void post("settings", { alwaysAsk: !alwaysAsk })} />
    </label>
    <label className="mb-3 flex items-center gap-2 text-xs text-ink-secondary"><input type="checkbox" checked={compare} onChange={event => setCompare(event.target.checked)} />Stop on screenshot mismatch (exact image comparison)</label>
    <div className="divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
      {playbooks.map(({ playbook, approved, runs }) => <div key={playbook.name} className="p-3">
        <div className="flex items-center justify-between gap-3">
          <div><div className="text-sm text-ink">{playbook.title}</div><div className="text-xs text-ink-secondary">{playbook.computerKind} · {playbook.steps.length} steps · {approved ? "Approved for this bot" : "Approval required"}</div></div>
          <button className="rounded-lg bg-control px-3 py-1.5 text-sm text-ink disabled:opacity-50" disabled={working || runs.some(run => ["running", "awaiting-approval"].includes(run.status))} onClick={() => void post("replay", { name: playbook.name, compareScreenshots: compare })}>Replay</button>
        </div>
        {runs.length > 0 && <ol aria-label={`Run history for ${playbook.title}`} className="mt-2 text-xs text-ink-secondary">
          {runs.map(run => <li key={run.id}>{new Date(run.startedAt).toLocaleString()} · {run.status} · {run.completedSteps}/{playbook.steps.length} steps{run.failedStep === undefined ? "" : ` · stopped at step ${run.failedStep + 1} (index ${run.failedStep})`}{run.error ? ` · ${run.error}` : ""}</li>)}
        </ol>}
      </div>)}
      {!playbooks.length && <p className="p-3 text-xs text-ink-secondary">Record a demonstration from the Computer panel to create a playbook.</p>}
    </div>
    {message && <p role="status" className="mt-2 text-xs text-ink-secondary">{message}</p>}
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
  </Card>;
}

import { useEffect, useState } from "react";
import type { GithubRoutineTriggerInput } from "../../../shared/routines";
import { api } from "@/state/store";

const EVENTS = ["push", "pull_request", "issues", "release", "issue_comment", "pull_request_review", "workflow_run", "check_run", "create", "delete", "fork", "star"];
const fieldClass = "w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[12.5px] text-ink outline-none focus:border-accent";
export function newGithubSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
}
function useWebhookUrl(routineId?: string) {
  const [base, setBase] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api("/api/webhooks").then(response => { if (active) { setBase(response.ingress?.baseUrl ?? ""); if (!response.ingress?.available) setError("Webhook receiver is unavailable."); } }).catch(() => { if (active) setError("Could not load the webhook URL."); });
    return () => { active = false; };
  }, []);
  return { url: routineId && base ? `${base.replace(/\/$/, "")}/hooks/github/${routineId}` : "", error };
}
export function GithubWebhookUrl({ routineId }: { routineId?: string }) {
  const { url, error } = useWebhookUrl(routineId);
  return <div className="space-y-1.5">
    <label className="block text-[12px] font-medium text-ink">Webhook URL<input aria-label="GitHub webhook URL" readOnly value={url} placeholder={routineId ? "Loading webhook URL…" : "Available after saving"} className={fieldClass} /></label>
    <p className="text-[11px] text-ink-secondary">Paste into GitHub → Repository settings → Webhooks. Choose application/json. Use a public HTTPS receiver URL for GitHub to reach this server.</p>
    {error && <p role="alert" className="text-[11px] text-danger">{error}</p>}
  </div>;
}
export function GithubTriggerFields({ value, routineId, onChange }: { value: GithubRoutineTriggerInput; routineId?: string; onChange: (value: GithubRoutineTriggerInput) => void }) {
  const [actionsText, setActionsText] = useState(value.actions?.join(", ") ?? "");
  return <div className="space-y-3 rounded-xl border border-hairline/50 bg-inset/40 p-3">
    <label className="block text-[12px] font-medium text-ink">Repository<input aria-label="GitHub repository" placeholder="owner/name" value={value.repo} onChange={event => onChange({ ...value, repo: event.target.value })} className={fieldClass} /></label>
    <fieldset><legend className="mb-2 text-[12px] font-medium text-ink">GitHub events</legend><div className="flex flex-wrap gap-x-4 gap-y-2">
      {[...new Set([...EVENTS, ...value.events])].map(name => <label key={name} className="flex items-center gap-1.5 text-[12px] text-ink"><input type="checkbox" checked={value.events.includes(name)} onChange={event => onChange({ ...value, events: event.target.checked ? [...value.events, name] : value.events.filter(current => current !== name) })} />{name}</label>)}
    </div></fieldset>
    <label className="block text-[12px] font-medium text-ink">Actions (optional)<input aria-label="GitHub actions" placeholder="opened, merged" value={actionsText} onChange={event => { setActionsText(event.target.value); onChange({ ...value, actions: event.target.value.split(",").map(action => action.trim()).filter(Boolean) }); }} className={fieldClass} /></label>
    <p className="text-[11px] text-ink-secondary">Leave actions empty to accept every action. “merged” matches a closed, merged pull request. Action filters also exclude events without an action.</p>
    <div className="flex items-center justify-between gap-3 text-[11px] text-ink-secondary"><span>{value.secret ? "A new secret will be shown once after saving." : "The saved secret is hidden."}</span><button type="button" onClick={() => onChange({ ...value, secret: newGithubSecret() })} className="shrink-0 rounded-lg border border-hairline/50 px-2 py-1 text-ink hover:bg-raised">Generate new secret</button></div>
    <GithubWebhookUrl routineId={routineId} />
  </div>;
}
export function GithubSecretSetup({ routineId, secret, onClose }: { routineId: string; secret: string; onClose: () => void }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-3 backdrop-blur-sm"><div role="dialog" aria-modal="true" aria-label="GitHub routine saved" className="w-full max-w-xl space-y-4 rounded-2xl border border-hairline/60 bg-panel p-6 shadow-2xl">
    <h2 className="text-[16px] font-semibold text-ink">GitHub routine saved</h2>
    <GithubWebhookUrl routineId={routineId} />
    <label className="block text-[12px] font-medium text-ink">Secret<input aria-label="GitHub secret" readOnly value={secret} className={fieldClass} /></label>
    <p className="text-[12px] text-ink-secondary">Copy this secret into GitHub now. It will be hidden when you close this screen. Generate a new secret in the editor if you lose it.</p>
    <button type="button" autoFocus onClick={onClose} className="rounded-lg bg-accent px-4 py-2 text-[12px] font-semibold text-accent-ink">Done</button>
  </div></div>;
}

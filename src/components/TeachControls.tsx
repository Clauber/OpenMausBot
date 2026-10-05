import { useEffect, useState } from "react";
import type { TaughtSession } from "../../shared/taught-skills";

const fieldClass = "w-full rounded-lg border border-hairline/40 bg-inset px-2 py-1.5 text-sm text-ink";
const buttonClass = "rounded-lg bg-control px-3 py-1.5 text-sm text-ink disabled:opacity-50";
export function TeachControls({ botId, threadId }: { botId: string; threadId: string }) {
  const base = `/api/bots/${encodeURIComponent(botId)}/tasks/${encodeURIComponent(threadId)}/teach`;
  const [session, setSession] = useState<TaughtSession | null>(null);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [tool, setTool] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch(base); const body = await response.json();
        if (response.ok && !cancelled) setSession(body.session);
      } catch { /* The explicit operation reports connection failures. */ }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [base]);
  const perform = async (operation: string, payload = {}) => {
    if (working) return;
    setWorking(true); setError(""); setMessage("");
    try {
      const response = await fetch(`${base}/${operation}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Teaching operation failed.");
      if (body.session) { setSession(body.session); setTool(body.session.tools[0]?.name ?? ""); }
      if (operation === "stop") { setSession(null); setMessage(`Saved ${body.playbook.title}. Replay it from Skills.`); }
      if (operation === "discard") { setSession(null); setMessage("Recording discarded."); }
      if (operation === "action") {
        const current = await (await fetch(base)).json(); setSession(current.session);
        if (body.result?.isError) throw new Error("The demonstration step failed; inspect the computer before continuing.");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Teaching operation failed."); }
    finally { setWorking(false); }
  };
  const selected = session?.tools.find(item => item.name === tool);
  const properties = selected?.inputSchema?.properties ?? {};
  const args = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== "").map(([key, value]) =>
    [key, properties[key]?.type === "number" || properties[key]?.type === "integer" ? Number(value) : value]));
  return <section aria-label="Teach a computer task" className="my-3 rounded-xl border border-hairline/40 bg-card p-3">
    <div className="text-sm font-medium text-ink">Teach a task</div>
    <p className="my-2 text-xs text-ink-secondary">Record computer actions, then review and replay the saved playbook from Skills.</p>
    {session ? <>
      <p role="status" className="text-xs text-ink-secondary">Recording {session.title} · {session.steps.length} steps</p>
      <label className="mt-2 block text-xs text-ink-secondary">Demonstrate an action
        <select aria-label="Demonstration action" className={fieldClass} value={tool} onChange={event => { setTool(event.target.value); setValues({}); }}>
          {session.tools.map(item => <option key={item.name} value={item.name}>{item.name.replace(/_/g, " ")}</option>)}
        </select>
      </label>
      {Object.entries(properties).filter(([, schema]) => ["string", "number", "integer"].includes(schema.type ?? "")).map(([name, schema]) =>
        <label className="mt-2 block text-xs text-ink-secondary" key={name}>{name.replace(/_/g, " ")}
          {schema.enum ? <select aria-label={`Action ${name}`} className={fieldClass} value={values[name] ?? ""} onChange={event => setValues({ ...values, [name]: event.target.value })}>
            <option value="">Choose…</option>{schema.enum.map(value => <option key={value}>{value}</option>)}
          </select> : <input aria-label={`Action ${name}`} className={fieldClass} type={schema.type === "string" ? "text" : "number"} value={values[name] ?? ""} onChange={event => setValues({ ...values, [name]: event.target.value })} />}
        </label>)}
      <div className="mt-3 flex flex-wrap gap-2">
        <button className={buttonClass} disabled={working || !tool || session.pending > 0} onClick={() => void perform("action", { tool, args })}>Perform action</button>
        <button className={buttonClass} disabled={working || session.pending > 0 || !session.steps.length} onClick={() => void perform("stop")}>Stop and save</button>
        <button className={buttonClass} disabled={working} onClick={() => void perform("discard")}>Discard</button>
      </div>
    </> : <>
      <input aria-label="Demonstration title" placeholder="Task title" maxLength={120} className={fieldClass} value={title} onChange={event => setTitle(event.target.value)} />
      <textarea aria-label="Narration notes" placeholder="Narration notes (optional)" maxLength={4000} className={`${fieldClass} mt-2`} value={notes} onChange={event => setNotes(event.target.value)} />
      <button className={`${buttonClass} mt-2`} disabled={working || !title.trim()} onClick={() => void perform("start", { title, notes })}>Start recording</button>
    </>}
    {message && <p role="status" className="mt-2 text-xs text-ink-secondary">{message}</p>}
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
  </section>;
}

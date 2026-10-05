import { useState } from "react";
import { useSpaces } from "@/state/spaces";

/** Sidebar filter: show one space's bots, or all. Hidden until a second space exists. */
export function SpaceSwitcher() {
  const { spaces, chosen, choose, create } = useSpaces();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  if (spaces.length < 2 && !adding) {
    return (
      <button type="button" data-testid="space-add" className="px-3 py-1 text-left text-[11px] text-ink-secondary underline" onClick={() => setAdding(true)}>
        New space
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1 px-3 py-1" data-testid="space-switcher">
      {spaces.length > 1 && (
        <select aria-label="Space" className="min-w-0 flex-1 rounded border border-hairline bg-card px-1 py-0.5 text-[12px]"
          value={chosen ?? ""} onChange={(event) => choose(event.target.value || null)}>
          <option value="">All spaces</option>
          {spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
        </select>
      )}
      {adding ? (
        <form className="flex gap-1" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void create(name.trim()).then(() => { setName(""); setAdding(false); }).catch(() => undefined); }}>
          <input aria-label="New space name" autoFocus className="w-24 rounded border border-hairline bg-card px-1 text-[12px]" value={name} onChange={(event) => setName(event.target.value)} />
          <button type="submit" className="text-[11px] underline">Add</button>
        </form>
      ) : (
        <button type="button" aria-label="New space" className="text-[12px] text-ink-secondary" onClick={() => setAdding(true)}>+</button>
      )}
    </div>
  );
}

/** Space picker for one bot (bot settings). */
export function BotSpacePicker({ botId }: { botId: string }) {
  const { spaces, assignments, assign } = useSpaces();
  if (spaces.length < 2) return null;
  const current = assignments.bot?.[botId] ?? "personal";
  return (
    <label className="mt-3 flex items-center justify-between gap-3 text-[13px]">
      <span>Space</span>
      <select aria-label="Bot space" data-testid="bot-space" className="rounded border border-hairline bg-card px-2 py-1"
        value={current} onChange={(event) => void assign("bot", botId, event.target.value)}>
        {spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
      </select>
    </label>
  );
}

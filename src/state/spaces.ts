import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "@/state/store";

export interface SpaceInfo { id: string; name: string; createdAt: number }
export interface SpacesState {
  spaces: SpaceInfo[];
  assignments: Record<string, Record<string, string>>;
}
const KEY = "omb.space";
const PERSONAL = "personal";
let snapshot: SpacesState = { spaces: [], assignments: {} };
let selected: string | null = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function spaceOf(state: SpacesState, kind: string, id: string): string {
  return state.assignments[kind]?.[id] ?? PERSONAL;
}
/** Whether the sidebar shows this bot under the chosen space (null = all spaces). */
export function inSelectedSpace(state: SpacesState, chosen: string | null, botId: string): boolean {
  return !chosen || spaceOf(state, "bot", botId) === chosen;
}
function reload(): Promise<void> {
  loading ??= api<SpacesState>("/api/spaces").then((data) => {
    snapshot = { spaces: data.spaces, assignments: data.assignments };
    if (selected && !data.spaces.some((space) => space.id === selected)) selected = null;
    emit();
  }).catch(() => undefined).finally(() => { loading = null; });
  return loading;
}
export function useSpaces() {
  const state = useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => snapshot, () => snapshot);
  const chosen = useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => selected, () => selected);
  useEffect(() => { void reload(); }, []);
  const choose = useCallback((id: string | null) => {
    selected = id; emit();
    try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch { /* private mode */ }
  }, []);
  const assign = useCallback(async (kind: string, id: string, spaceId: string) => {
    const data = await api<SpacesState>("/api/spaces/assign", { method: "PUT", body: JSON.stringify({ kind, id, spaceId }) });
    snapshot = { spaces: data.spaces, assignments: data.assignments }; emit();
  }, []);
  const create = useCallback(async (name: string) => {
    const data = await api<SpacesState & { space: SpaceInfo }>("/api/spaces", { method: "POST", body: JSON.stringify({ name }) });
    snapshot = { spaces: data.spaces, assignments: data.assignments }; emit();
    return data.space;
  }, []);
  return { ...state, chosen, choose, assign, create, reload };
}

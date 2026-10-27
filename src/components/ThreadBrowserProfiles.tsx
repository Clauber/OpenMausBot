import { useEffect, useRef, useState } from "react";
import { api, type Bot } from "@/state/store";
import { isOwnerOrAdmin, readSessionState } from "@/lib/session";
import { Select } from "./Select";
import { SignedInSites } from "./SignedInSites";
import { threadBrowserProfileSchema, type ThreadBrowserProfile } from "../../shared/thread-browser-profile";

export function useThreadBrowserProfile(bot: Bot) {
  const path = `/api/bots/${encodeURIComponent(bot.id)}/browser-profile?threadId=${encodeURIComponent(bot.threadId)}`;
  const [result, setResult] = useState<{ path: string; profile: ThreadBrowserProfile | null; error: string; saving: boolean }>({ path, profile: null, error: "", saving: false });
  const [canSelect, setCanSelect] = useState(false);
  const identity = useRef(path);
  const request = useRef(0);
  if (identity.current !== path) { identity.current = path; request.current++; }
  useEffect(() => {
    let current = true;
    void readSessionState().then(session => { if (current) setCanSelect(isOwnerOrAdmin(session)); }).catch(() => {});
    return () => { current = false; };
  }, []);
  useEffect(() => {
    const sequence = ++request.current;
    let current = true;
    setResult(previous => previous.path === path ? { ...previous, saving: false } : { path, profile: null, error: "", saving: false });
    void api(path).then((value: unknown) => {
      const profile = threadBrowserProfileSchema.parse(value);
      if (current && sequence === request.current) setResult({ path, profile, error: "", saving: false });
    }).catch((cause: unknown) => {
      if (current && sequence === request.current) setResult(previous => ({ path, profile: previous.path === path ? previous.profile : null, error: cause instanceof Error ? cause.message : "Could not read browser profiles.", saving: false }));
    });
    return () => { current = false; };
  }, [path, bot.busy, bot.tasks]);
  const select = async (profileId: string | null) => {
    const sequence = ++request.current;
    setResult(previous => ({ path, profile: previous.path === path ? previous.profile : null, error: "", saving: true }));
    try {
      const value: unknown = await api(path, { method: "PUT", body: JSON.stringify({ profileId }) });
      const profile = threadBrowserProfileSchema.parse(value);
      if (identity.current === path && sequence === request.current) setResult({ path, profile, error: "", saving: false });
    } catch (cause) {
      if (identity.current === path && sequence === request.current) setResult(previous => ({ ...previous, error: cause instanceof Error ? cause.message : "Could not select browser profile.", saving: false }));
    }
  };
  const visible = result.path === path ? result : { profile: null, error: "", saving: false };
  return { profile: visible.profile, error: visible.error, saving: visible.saving, canSelect, select, botId: bot.id, threadId: bot.threadId };
}

export function ThreadBrowserProfiles({ profile, error, saving, canSelect, select, botId, threadId }: ReturnType<typeof useThreadBrowserProfile>) {
  if (!profile) return <p role="status" className="text-[12px] text-ink-secondary">{error || "Loading conversation profiles..."}</p>;
  const name = (id: string | null) => profile.profiles.find(candidate => candidate.id === id)?.name ?? "Removed profile";
  const missing = !profile.profiles.some(candidate => candidate.id === profile.requestedProfileId);
  return <section className="mb-5 space-y-2 border-b border-hairline pb-4">
    <label className="block text-[13px] font-medium">Conversation browser
      <Select aria-label="Conversation browser profile" value={profile.requestedProfileId ?? ""} disabled={saving || !canSelect}
        onChange={event => void select(event.target.value || null)}>
        {missing && <option value={profile.requestedProfileId ?? ""} disabled>Removed profile</option>}
        {profile.profiles.map(candidate => <option key={candidate.id ?? ""} value={candidate.id ?? ""}>{candidate.name}</option>)}
      </Select>
    </label>
    <p role="status" className="text-[12px] text-ink-secondary">
      {profile.active ? `Current turn: ${name(profile.active.profileId)}.` : `Viewing: ${name(profile.viewerProfileId)}. No browser is mounted for an active turn.`}
      {profile.status === "pending" || profile.status === "reconnect" ? ` Requested: ${name(profile.requestedProfileId)}. Start the next turn to use it.` : ""}
    </p>
    {!canSelect && <p className="text-[12px] text-ink-secondary">Only an owner or admin may change browser identity.</p>}
    <p className="text-[12px] text-ink-secondary">This choice applies to this conversation. The bot's default stays unchanged.</p>
    {profile.viewerProfileId !== "guest" && <SignedInSites key={`${botId}:${threadId}:${profile.viewerProfileId ?? ""}`} target={{ bot: botId }} scope={{ threadId }} sharedBy={[]} disabled={saving || !canSelect} />}
    {(error || profile.status === "error") && <p role="alert" className="text-[12px] text-danger">{error || (profile.status === "error" ? profile.error : "")}</p>}
  </section>;
}

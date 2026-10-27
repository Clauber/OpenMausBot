import { z } from "zod";
import type { AppConfig } from "./config.ts";
import type { Store } from "./store.ts";
import type { ThreadBrowserProfile } from "../shared/thread-browser-profile.ts";

export const BROWSER_PROFILE_TOOLS = [
  { name: "browser_profiles_list", description: "List this conversation's available browser profiles and its active and requested profile. Ready means a matching mounted session, not that Chrome or a page has loaded. Does not start or control a browser.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "browser_profile_select", description: "Request a browser profile for this conversation's NEXT turn. The current turn keeps its active browser. Does not take control or change the bot default.", inputSchema: { type: "object", properties: { profileId: { type: ["string", "null"], description: "A listed profile id, guest, or null for the bot's own browser." } }, required: ["profileId"], additionalProperties: false } },
];

export const profileSelectionSchema = z.object({ profileId: z.string().min(1).max(100).nullable() }).strict();

export interface BrowserProfileBinding { profileId: string | null; session: string }

export function createThreadBrowserProfiles(deps: {
  cfg: Pick<AppConfig, "browserProfiles">;
  store(): Pick<Store, "bot" | "taskByThread" | "patchTask" | "groupByThread" | "groupTaskByThread" | "patchGroupTask" | "patchGroup">;
  active(botId: string, threadId: string): BrowserProfileBinding | undefined;
  refusal(botId: string, threadId: string, profileId: string | null): string | null;
}) {
  function conversation(botId: string, threadId: string) {
    const store = deps.store();
    const bot = store.bot(botId);
    if (!bot) throw Object.assign(new Error("no such conversation"), { status: 404 });
    const task = store.taskByThread(botId, threadId);
    if (task) return {
      defaultProfile: bot.browserProfile ?? null, requested: task.requestedBrowserProfile, mounted: task.lastMountedBrowserProfile,
      set: (kind: "requested" | "mounted", profileId: string | null) => store.patchTask(botId, threadId,
        kind === "requested" ? { requestedBrowserProfile: profileId } : { lastMountedBrowserProfile: profileId }),
    };
    const group = store.groupByThread(threadId);
    const record = group?.memberIds.includes(botId) ? group.dm ? group : store.groupTaskByThread(group.id, threadId) : undefined;
    if (!group || !record) throw Object.assign(new Error("no such conversation"), { status: 404 });
    return {
      defaultProfile: bot.browserProfile ?? null, requested: record.requestedBrowserProfiles?.[botId], mounted: record.lastMountedBrowserProfiles?.[botId],
      set: (kind: "requested" | "mounted", profileId: string | null) => {
        const patch = kind === "requested"
          ? { requestedBrowserProfiles: { ...record.requestedBrowserProfiles, [botId]: profileId } }
          : { lastMountedBrowserProfiles: { ...record.lastMountedBrowserProfiles, [botId]: profileId } };
        return group.dm ? store.patchGroup(group.id, patch) : store.patchGroupTask(group.id, threadId, patch);
      },
    };
  }

  function requested(botId: string, threadId: string): string | null {
    const record = conversation(botId, threadId);
    return record.requested !== undefined ? record.requested : record.defaultProfile;
  }

  function viewerProfile(botId: string, threadId: string): string | null {
    const active = deps.active(botId, threadId);
    if (active) return active.profileId;
    const record = conversation(botId, threadId);
    return record.mounted !== undefined ? record.mounted : record.defaultProfile;
  }

  function mounted(botId: string, threadId: string, profileId: string | null) {
    const record = conversation(botId, threadId);
    if (record.mounted !== profileId) record.set("mounted", profileId);
  }

  function state(botId: string, threadId: string): ThreadBrowserProfile {
    const requestedProfileId = requested(botId, threadId);
    const active = deps.active(botId, threadId);
    const fields = {
      active: active ? { profileId: active.profileId } : null,
      activeProfileId: active?.profileId ?? null, requestedProfileId, viewerProfileId: viewerProfile(botId, threadId),
      profiles: [{ id: null, name: "Own browser" }, { id: "guest", name: "Temporary browser" }, ...(deps.cfg.browserProfiles ?? []).map(({ id, name }) => ({ id, name }))],
    };
    if (requestedProfileId !== null && requestedProfileId !== "guest" && !deps.cfg.browserProfiles?.some(profile => profile.id === requestedProfileId)) {
      return { ...fields, status: "error", error: "The requested browser profile was deleted. Select an available profile." };
    }
    const refusal = conversation(botId, threadId).requested !== undefined && deps.cfg.browserProfiles?.some(profile => profile.id === requestedProfileId && profile.browser === "chrome")
      ? "My Chrome is unavailable for conversation selection because its shared browser connection cannot isolate profiles or audiences."
      : deps.refusal(botId, threadId, requestedProfileId);
    if (refusal) return { ...fields, status: "error", error: refusal };
    return { ...fields, status: active ? active.profileId === requestedProfileId ? "ready" : "pending" : "reconnect" };
  }

  function activation(botId: string, threadId: string) {
    const current = state(botId, threadId);
    const explicit = conversation(botId, threadId).requested !== undefined;
    if (explicit && current.status === "error") throw new Error(current.error);
    return { profileId: current.requestedProfileId, explicit };
  }

  function select(botId: string, threadId: string, input: unknown): ThreadBrowserProfile {
    const record = conversation(botId, threadId);
    const parsed = profileSelectionSchema.safeParse(input);
    if (!parsed.success) throw Object.assign(new Error("profileId must be a listed profile id or null"), { status: 400 });
    const { profileId } = parsed.data;
    if (profileId !== null && profileId !== "guest" && !deps.cfg.browserProfiles?.some(profile => profile.id === profileId)) {
      throw Object.assign(new Error("browser profile is unavailable or was deleted"), { status: 400 });
    }
    const refusal = deps.cfg.browserProfiles?.some(profile => profile.id === profileId && profile.browser === "chrome")
      ? "My Chrome is unavailable for conversation selection because its shared browser connection cannot isolate profiles or audiences."
      : deps.refusal(botId, threadId, profileId);
    if (refusal) throw Object.assign(new Error(refusal), { status: 409 });
    if (record.requested !== profileId) record.set("requested", profileId);
    return state(botId, threadId);
  }

  return { requested, state, select, mounted, viewerProfile, activation };
}

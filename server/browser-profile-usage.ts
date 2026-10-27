import type { TurnOwner, TurnResources } from "./turn-resources.ts";

export interface BrowserProfileUse {
  botId: string;
  name: string;
  profileId: string | null;
  sessions: readonly string[];
}

export function createBrowserProfileUsage(deps: {
  bots(): readonly { id: string; name: string; busy?: boolean; browser?: boolean; browserProfile?: string }[];
  mounted(): Iterable<{ botId: string; profileId: string | null; session: string }>;
  sessionsOf(botId: string, profileId: string | undefined): readonly string[];
  session(botId: string, threadId: string, profileId: string | null): string;
  generation(threadId: string): string | undefined;
  botForThread(threadId: string): string | undefined;
  resources: Pick<TurnResources, "blocker" | "holder">;
  heldBy(session: string): string | null;
  unavailable(profileId: string | null): string | null;
}) {
  function users(): BrowserProfileUse[] {
    const bots = deps.bots();
    const result: BrowserProfileUse[] = [];
    for (const bot of bots) {
      if (bot.busy && bot.browser !== false) result.push({ botId: bot.id, name: bot.name, profileId: bot.browserProfile ?? null, sessions: deps.sessionsOf(bot.id, bot.browserProfile) });
    }
    for (const binding of deps.mounted()) {
      const bot = bots.find(candidate => candidate.id === binding.botId);
      if (bot) result.push({ botId: bot.id, name: bot.name, profileId: binding.profileId, sessions: [binding.session] });
    }
    return result;
  }

  function sessionUsers(session: string): BrowserProfileUse[] {
    const result = users().filter(user => user.sessions.includes(session));
    const holder = deps.resources.holder(`browser:${session}`);
    const bot = holder ? deps.bots().find(candidate => candidate.id === deps.botForThread(holder.threadId)) : undefined;
    if (bot && !result.some(user => user.botId === bot.id)) result.push({ botId: bot.id, name: bot.name, profileId: bot.browserProfile ?? null, sessions: [session] });
    return result;
  }

  function refusal(botId: string, threadId: string, profileId: string | null): string | null {
    const unavailable = deps.unavailable(profileId);
    if (unavailable) return unavailable;
    const session = deps.session(botId, threadId, profileId);
    const owner: TurnOwner = { threadId, generation: deps.generation(threadId) ?? "" };
    if (deps.resources.blocker(`browser:${session}`, owner)) return "Another thread is using the requested browser. Wait until it finishes.";
    if (deps.heldBy(session)) return "A person controls the requested browser. Wait until they hand it back.";
    return null;
  }

  return { users, sessionUsers, refusal };
}

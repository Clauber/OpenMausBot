// The Apps → Access manager's rules: which apps there are (installed MCP
// servers plus the built-in catalog), which bots have which, and what a
// toggle writes. Pure, so the matrix and the per-bot view share one answer.
import { mcpServersForBot, type McpServerSummary } from "@/lib/mcp-servers";
import type { Bot, InstanceInfo } from "@/state/store";

/** One catalog entry as /api/mcp/catalog lists it: secret NAMES only. */
export interface CatalogApp {
  name: string;
  label: string;
  description: string;
  transport: "http" | "sse" | "stdio";
  target: string;
  installed: boolean;
  enabled: boolean;
  secrets: Array<{ name: string; envKey?: string; available: boolean }>;
}

export interface AccessApp {
  name: string;
  label: string;
  description: string;
  /** stored in config.json mcpServers */
  installed: boolean;
  /** stored and switched on, so a grant reaches the bot's next turn */
  enabled: boolean;
  /** secrets an install still needs that this server cannot find itself */
  missingSecrets: string[];
}

/** Installed servers first (as the person has them), then the catalog's
 * apps that are not installed yet, each group in a stable order. */
export function buildAccessApps(servers: McpServerSummary[], catalog: CatalogApp[]): AccessApp[] {
  const byName = new Map(catalog.map((app) => [app.name, app] as const));
  const installed: AccessApp[] = servers.map((server) => {
    const known = byName.get(server.name);
    return {
      name: server.name,
      label: known?.label ?? server.name,
      description: known?.description ?? "",
      installed: true,
      enabled: server.enabled,
      missingSecrets: [],
    };
  });
  const have = new Set(servers.map((server) => server.name));
  const available: AccessApp[] = catalog
    .filter((app) => !have.has(app.name))
    .map((app) => ({
      name: app.name,
      label: app.label,
      description: app.description,
      installed: false,
      enabled: false,
      missingSecrets: app.secrets.filter((secret) => !secret.available).map((secret) => secret.name),
    }));
  return [...installed, ...available];
}

export function matchesAccessSearch(app: AccessApp, search: string): boolean {
  const needle = search.trim().toLowerCase();
  return !needle || `${app.label} ${app.name} ${app.description}`.toLowerCase().includes(needle);
}

/** Does this bot's next turn mount the app? Same rule as a turn:
 * its own list when it has one, else every enabled server. */
export function botHasApp(bot: Pick<Bot, "mcpServers">, servers: McpServerSummary[], app: string): boolean {
  return mcpServersForBot(servers, bot.mcpServers).some((server) => server.name === app);
}

/** The list a toggle saves. A bot on "every enabled server" is given an
 * explicit list of what it has today, with the app added or removed, so a
 * later install elsewhere never reaches it unasked. `enabledBefore` is the
 * enabled set from before the app was switched on. */
export function nextBotGrant(
  bot: Pick<Bot, "mcpServers">,
  enabledBefore: string[],
  app: string,
  on: boolean,
): string[] {
  const base = bot.mcpServers ?? enabledBefore;
  return on ? [...new Set([...base, app])] : base.filter((name) => name !== app);
}

/** Bots that appear in the matrix: the ones a person can see and act on. */
export function accessBots(bots: Bot[]): Bot[] {
  return bots.filter((bot) => !bot.hidden);
}

/** Why a bot's switches are locked, or null. A running bot cannot have its
 * servers changed under it; an engine that cannot mount MCP servers has
 * nothing to switch. */
export function accessLockReason(bot: Bot, instances: InstanceInfo[]): "busy" | "engine" | null {
  if (bot.busy) return "busy";
  const capabilities = instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)?.capabilities;
  // older hosts do not report the capability: only an explicit false locks
  return capabilities?.customMcp === false ? "engine" : null;
}

/** How many apps a bot has, counting only the ones the matrix lists. */
export function botAppCount(bot: Pick<Bot, "mcpServers">, servers: McpServerSummary[]): number {
  return mcpServersForBot(servers, bot.mcpServers).length;
}

export interface AccessDeps {
  api: (path: string, init?: RequestInit) => Promise<{ servers?: McpServerSummary[] }>;
  /** save the bot's server list the way every other bot edit is saved */
  saveGrant: (botId: string, mcpServers: string[]) => void;
  publishServers: (servers: McpServerSummary[]) => void;
  reloadCatalog: () => Promise<unknown>;
}

/** The whole toggle. Turning an app on that is not installed (or is
 * switched off) first asks the server to install or enable it, which writes
 * one ordinary config.json entry and leaves other bots' access as it was;
 * then the bot's own list is saved. Turning off only edits the list: the
 * app stays installed. Nothing is saved for the bot if the install fails. */
export async function setAppAccess(
  deps: AccessDeps,
  input: { app: AccessApp; bot: Pick<Bot, "id" | "mcpServers">; on: boolean; servers: McpServerSummary[]; secrets?: Record<string, string> },
): Promise<void> {
  const { app, bot, on, servers, secrets } = input;
  const enabledBefore = servers.filter((server) => server.enabled).map((server) => server.name);
  if (on && !(app.installed && app.enabled)) {
    const result = await deps.api(`/api/mcp/apps/${app.name}/enable`, {
      method: "POST",
      body: JSON.stringify(secrets ? { secrets } : {}),
    });
    deps.publishServers(result.servers ?? []);
    await deps.reloadCatalog();
  }
  deps.saveGrant(bot.id, nextBotGrant(bot, enabledBefore, app.name, on));
}

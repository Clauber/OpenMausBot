// Apps → Access: which bot may use which app, in one place. Rows are apps
// (the MCP servers already installed, then the built-in catalog's apps that
// are not), columns are bots, and each cell is a switch. A switch writes the
// bot's own server list, so it takes effect on that bot's next turn; turning
// on an app that is not installed yet installs it first.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Wrench } from "lucide-react";

import {
  accessBots,
  accessLockReason,
  botAppCount,
  botHasApp,
  buildAccessApps,
  matchesAccessSearch,
  setAppAccess,
  type AccessApp,
  type CatalogApp,
} from "@/lib/mcp-access";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { updateMcpServers, useMcpServers, type McpServerSummary } from "@/lib/mcp-servers";
import { api, useStore, type Bot, type InstanceInfo } from "@/state/store";

import { BotAvatar } from "./Avatar";
import { Switch } from "./SettingsPrimitives";

type Lock = "busy" | "engine" | null;
type AccessView = "app" | "bot";

interface BotTools {
  servers: Array<{ name: string; ok: boolean; tools: Array<{ name: string; description?: string }>; error?: string }>;
}

function appNote(app: AccessApp): string | null {
  if (!app.installed) {
    return app.missingSecrets.length
      ? t("apps.access.needsSecret", { names: app.missingSecrets.join(", ") })
      : t("apps.access.notInstalled");
  }
  return app.enabled ? null : t("apps.access.switchedOff");
}

function lockText(lock: Lock): string | undefined {
  return lock === "busy" ? t("apps.access.busy") : lock === "engine" ? t("apps.access.engine") : undefined;
}

function AppCell({ label, app, bot, checked, lock, onToggle }: {
  label: string;
  app: AccessApp;
  bot: Bot;
  checked: boolean;
  lock: Lock;
  onToggle: (app: AccessApp, bot: Bot, on: boolean) => void;
}) {
  return (
    <Switch
      data-access-cell={`${app.name}:${bot.id}`}
      checked={checked}
      disabled={lock !== null}
      title={lockText(lock)}
      aria-label={t("apps.access.toggle", { bot: bot.name, app: label })}
      onClick={() => onToggle(app, bot, !checked)}
    />
  );
}

/** Apps × bots. Wide fleets scroll sideways under a pinned app column. */
export function AccessMatrix({ apps, bots, servers, instances, onToggle }: {
  apps: AccessApp[];
  bots: Bot[];
  servers: McpServerSummary[];
  instances: InstanceInfo[];
  onToggle: (app: AccessApp, bot: Bot, on: boolean) => void;
}) {
  const installed = apps.filter((app) => app.installed);
  const available = apps.filter((app) => !app.installed);
  const group = (title: string, rows: AccessApp[]) => rows.length === 0 ? null : (
    <>
      <tr>
        <th colSpan={bots.length + 1} scope="colgroup" className="sticky left-0 px-3 pb-1 pt-4 text-left text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">
          {title}
        </th>
      </tr>
      {rows.map((app) => {
        const note = appNote(app);
        return (
          <tr key={app.name} data-access-row={app.name} className="border-t border-hairline/30">
            <th scope="row" className="sticky left-0 z-[1] min-w-[220px] max-w-[260px] bg-menu px-3 py-2.5 text-left align-middle font-normal">
              <div className="truncate text-[13.5px] font-medium text-ink" title={app.name}>{app.label}</div>
              {note && <div className="mt-0.5 text-[11.5px] leading-snug text-ink-secondary">{note}</div>}
            </th>
            {bots.map((bot) => (
              <td key={bot.id} className="px-3 py-2.5 text-center align-middle">
                <AppCell
                  label={app.label}
                  app={app}
                  bot={bot}
                  checked={botHasApp(bot, servers, app.name)}
                  lock={accessLockReason(bot, instances)}
                  onToggle={onToggle}
                />
              </td>
            ))}
          </tr>
        );
      })}
    </>
  );
  return (
    <div data-access-matrix className="overflow-x-auto rounded-xl border border-hairline/40 bg-menu">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-[1] bg-menu px-3 py-3 text-left text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">
              {t("apps.access.appColumn")}
            </th>
            {bots.map((bot) => (
              <th key={bot.id} scope="col" data-access-bot={bot.id} className="min-w-[88px] max-w-[120px] px-3 py-3 text-center align-bottom font-normal">
                <span className="mx-auto flex size-7 items-center justify-center overflow-hidden rounded-full">
                  <BotAvatar bot={bot} size={22} animated={false} />
                </span>
                <span className="mt-1 block truncate text-[12px] font-medium text-ink" title={bot.name}>{bot.name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {group(t("apps.access.installed"), installed)}
          {group(t("apps.access.available"), available)}
        </tbody>
      </table>
    </div>
  );
}

/** One bot's apps: every app with its switch, and on request the tools the
 * bot's next turn will have from them. */
export function BotAppsView({ bot, apps, servers, instances, tools, toolsState, onToggle, onShowTools }: {
  bot: Bot;
  apps: AccessApp[];
  servers: McpServerSummary[];
  instances: InstanceInfo[];
  tools: BotTools | null;
  toolsState: "idle" | "loading" | "error";
  onToggle: (app: AccessApp, bot: Bot, on: boolean) => void;
  onShowTools: () => void;
}) {
  const lock = accessLockReason(bot, instances);
  const on = apps.filter((app) => botHasApp(bot, servers, app.name));
  const off = apps.filter((app) => !botHasApp(bot, servers, app.name));
  const toolsFor = (name: string) => tools?.servers.find((server) => server.name === name);
  const row = (app: AccessApp) => {
    const granted = botHasApp(bot, servers, app.name);
    const listed = granted ? toolsFor(app.name) : undefined;
    const note = appNote(app);
    return (
      <div key={app.name} data-bot-app={app.name} className="px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-medium text-ink" title={app.name}>{app.label}</div>
            {note && <div className="mt-0.5 text-[11.5px] leading-snug text-ink-secondary">{note}</div>}
          </div>
          <AppCell label={app.label} app={app} bot={bot} checked={granted} lock={lock} onToggle={onToggle} />
        </div>
        {listed && (
          <div data-bot-app-tools={app.name} className="mt-2 text-[12px] text-ink-secondary">
            {listed.ok ? (
              listed.tools.length ? (
                <ul className="flex flex-wrap gap-1.5">
                  {listed.tools.map((tool) => (
                    <li key={tool.name} title={tool.description} className="rounded-md bg-inset px-2 py-0.5 font-mono text-[11.5px] text-ink">{tool.name}</li>
                  ))}
                </ul>
              ) : t("apps.access.toolsNone")
            ) : (
              <span className="text-danger">{t("apps.access.toolsFailed", { error: listed.error ?? "" })}</span>
            )}
          </div>
        )}
      </div>
    );
  };
  return (
    <div data-bot-apps={bot.id} className="rounded-xl border border-hairline/40 bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline/40 px-3 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full">
            <BotAvatar bot={bot} size={26} animated={false} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[14px] font-medium text-ink">{bot.name}</div>
            <div className="text-[12px] text-ink-secondary">{t("apps.access.botCount", { count: botAppCount(bot, servers) })}</div>
          </div>
        </div>
        <button
          type="button"
          data-bot-tools-button
          onClick={onShowTools}
          disabled={toolsState === "loading"}
          className="flex items-center gap-1.5 rounded-lg bg-control px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-60"
        >
          {toolsState === "loading" ? <Loader2 size={13} className="animate-spin" /> : <Wrench size={13} />}
          {toolsState === "loading" ? t("apps.access.toolsLoading") : t("apps.access.showTools")}
        </button>
      </div>
      {lock && <div className="px-3 pt-2 text-[12px] text-ink-secondary">{lockText(lock)}</div>}
      {toolsState === "error" && <div role="alert" className="px-3 pt-2 text-[12px] text-danger">{t("apps.access.toolsFailed", { error: "" })}</div>}
      <div className="divide-y divide-hairline/30">
        {on.length > 0 && <div className="px-3 pb-1 pt-3 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">{t("apps.access.onForBot")}</div>}
        {on.map(row)}
        {off.length > 0 && <div className="px-3 pb-1 pt-3 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">{t("apps.access.offForBot")}</div>}
        {off.map(row)}
      </div>
    </div>
  );
}

/** Asks once for the credentials an install needs and the server could not
 * find. They go to the server in the request and are never listed again. */
function SecretPrompt({ app, bot, onSubmit, onCancel }: {
  app: AccessApp;
  bot: Bot;
  onSubmit: (secrets: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const complete = app.missingSecrets.every((name) => (values[name] ?? "").trim() !== "");
  return (
    <form
      data-access-secret-form={app.name}
      className="mb-3 rounded-xl border border-hairline/40 bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete) onSubmit(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()])));
      }}
    >
      <div className="text-[13.5px] font-medium text-ink">{t("apps.access.secretTitle", { app: app.label })}</div>
      <div className="mt-0.5 text-[12px] text-ink-secondary">{t("apps.access.secretHelp")}</div>
      <div className="mt-3 space-y-2">
        {app.missingSecrets.map((name) => (
          <label key={name} className="block">
            <span className="font-mono text-[11.5px] text-ink-secondary">{name}</span>
            <input
              type="password"
              autoComplete="off"
              value={values[name] ?? ""}
              onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
              className="mt-1 w-full rounded-lg bg-inset px-3 py-2 font-mono text-[12.5px] text-ink focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button type="submit" disabled={!complete} className="rounded-lg bg-accent px-3 py-2 text-[12.5px] font-medium text-accent-ink disabled:opacity-40">
          {t("apps.access.secretSubmit", { bot: bot.name })}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg px-2 py-2 text-[12.5px] text-ink-secondary hover:text-ink">{t("common.cancel")}</button>
      </div>
    </form>
  );
}

export function AppAccessManager({ search }: { search: string }) {
  const { state, dispatch } = useStore();
  const { servers, error: serversError, refresh } = useMcpServers();
  const [catalog, setCatalog] = useState<CatalogApp[] | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [view, setView] = useState<AccessView>("app");
  const [botId, setBotId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{ app: AccessApp; bot: Bot } | null>(null);
  const [tools, setTools] = useState<BotTools | null>(null);
  const [toolsState, setToolsState] = useState<"idle" | "loading" | "error">("idle");
  const [toolsFor, setToolsFor] = useState<string | null>(null);
  const busy = useRef(false);

  const loadCatalog = useCallback(() => {
    setCatalogError(false);
    return api("/api/mcp/catalog")
      .then((result) => setCatalog(result.entries ?? []))
      .catch(() => { setCatalog((current) => current ?? []); setCatalogError(true); });
  }, []);
  useEffect(() => { void loadCatalog(); }, [loadCatalog]);

  const bots = useMemo(() => accessBots(state.bots), [state.bots]);
  const apps = useMemo(
    () => buildAccessApps(servers ?? [], catalog ?? []).filter((app) => matchesAccessSearch(app, search)),
    [servers, catalog, search],
  );
  const selected = bots.find((bot) => bot.id === botId) ?? bots[0] ?? null;

  const loadTools = useCallback((forBot: string) => {
    setToolsFor(forBot);
    setToolsState("loading");
    return api(`/api/bots/${forBot}/mcp-tools`)
      .then((result) => { setTools({ servers: result.servers ?? [] }); setToolsState("idle"); })
      .catch(() => setToolsState("error"));
  }, []);

  // Tools already on screen follow the bot's list: re-ask once its change has
  // been saved. A different bot starts blank.
  const grantSignature = selected ? JSON.stringify(selected.mcpServers ?? null) : "";
  useEffect(() => {
    if (!selected || toolsFor !== selected.id) return;
    const timer = setTimeout(() => { void loadTools(selected.id); }, 500);
    return () => clearTimeout(timer);
  }, [grantSignature, selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (toolsFor && selected?.id !== toolsFor) { setTools(null); setToolsFor(null); setToolsState("idle"); }
  }, [selected?.id, toolsFor]);

  const apply = useCallback(async (app: AccessApp, bot: Bot, on: boolean, secrets?: Record<string, string>) => {
    if (busy.current || !servers) return;
    busy.current = true;
    setMessage(null);
    try {
      await setAppAccess({
        api,
        saveGrant: (botId, mcpServers) => dispatch({ type: "updateBot", botId, patch: { mcpServers } }),
        publishServers: updateMcpServers,
        reloadCatalog: loadCatalog,
      }, { app, bot, on, servers, secrets });
      setPrompt(null);
    } catch (error) {
      setMessage(t("apps.access.error", { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      busy.current = false;
    }
  }, [servers, dispatch, loadCatalog]);

  const toggle = useCallback((app: AccessApp, bot: Bot, on: boolean) => {
    if (on && !app.installed && app.missingSecrets.length) {
      setPrompt({ app, bot });
      return;
    }
    void apply(app, bot, on);
  }, [apply]);

  const loading = servers === null || catalog === null;
  return (
    <section data-access-manager aria-labelledby="access-title" className="min-w-0 pt-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 id="access-title" className="text-[15px] font-medium text-ink">{t("apps.access.title")}</h3>
          <p className="mt-0.5 max-w-[640px] text-[12.5px] text-ink-secondary">{t("apps.access.intro")}</p>
        </div>
        <div className="flex items-center gap-2">
          {view === "bot" && selected && (
            <select
              aria-label={t("apps.access.pickBot")}
              data-access-bot-select
              value={selected.id}
              onChange={(event) => setBotId(event.target.value)}
              className="max-w-[200px] rounded-lg bg-control px-3 py-1.5 text-[12.5px] text-ink focus:outline-none"
            >
              {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select>
          )}
          <div className="flex rounded-lg bg-control/70 p-0.5" role="group" aria-label={t("apps.access.viewAria")}>
            {(["app", "bot"] as const).map((id) => (
              <button
                key={id}
                type="button"
                data-access-view={id}
                aria-pressed={view === id}
                onClick={() => setView(id)}
                className={cn("rounded-md px-3 py-1 text-[12.5px] font-medium", view === id ? "bg-accent text-accent-ink" : "text-ink-secondary hover:text-ink")}
              >
                {t(id === "app" ? "apps.access.byApp" : "apps.access.byBot")}
              </button>
            ))}
          </div>
        </div>
      </div>
      {(message || serversError || catalogError) && (
        <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
          {message ?? t("apps.access.loadFailed")}{" "}
          {!message && <button type="button" onClick={() => { void refresh(); void loadCatalog(); }} className="underline">{t("connectors.action.retry")}</button>}
        </div>
      )}
      <div className="mt-3">
        {prompt && (
          <SecretPrompt
            app={prompt.app}
            bot={prompt.bot}
            onCancel={() => setPrompt(null)}
            onSubmit={(secrets) => void apply(prompt.app, prompt.bot, true, secrets)}
          />
        )}
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-secondary">
            <Loader2 size={14} className="animate-spin" /> {t("mcp.loading")}
          </div>
        ) : bots.length === 0 ? (
          <div className="rounded-xl bg-inset px-4 py-6 text-center text-[13px] text-ink-secondary">{t("apps.access.noBots")}</div>
        ) : apps.length === 0 ? (
          <div className="rounded-xl bg-inset px-4 py-6 text-center text-[13px] text-ink-secondary">{t("apps.access.noApps")}</div>
        ) : view === "app" || !selected ? (
          <AccessMatrix apps={apps} bots={bots} servers={servers} instances={state.instances} onToggle={toggle} />
        ) : (
          <BotAppsView
            bot={selected}
            apps={apps}
            servers={servers}
            instances={state.instances}
            tools={toolsFor === selected.id ? tools : null}
            toolsState={toolsFor === selected.id ? toolsState : "idle"}
            onToggle={toggle}
            onShowTools={() => void loadTools(selected.id)}
          />
        )}
        <p className="mt-3 text-[11.5px] text-ink-secondary">{t("apps.access.keepInstalled")}</p>
      </div>
    </section>
  );
}

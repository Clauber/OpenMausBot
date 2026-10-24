// Apps → Access: which bot may use which app, in one place. Rows are apps
// (the MCP servers already installed, then the built-in catalog's apps that
// are not), columns are bots, and each cell is a switch. A switch writes the
// bot's own server list, so it takes effect on that bot's next turn; turning
// on an app that is not installed yet installs it first.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

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
import { t } from "@/lib/i18n";
import { updateMcpServers, useMcpServers, type McpServerSummary } from "@/lib/mcp-servers";
import { api, useStore, type Bot, type InstanceInfo } from "@/state/store";

import { GrantBotView, GrantManagerHeader, GrantMatrix, type GrantRow, type GrantRules } from "./GrantGrid";

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

function lockText(lock: "busy" | "engine" | null): string | null {
  return lock === "busy" ? t("apps.access.busy") : lock === "engine" ? t("apps.access.engine") : null;
}

/** Rows the shared grid draws for the apps on screen. */
function appRows(apps: AccessApp[], grouped: boolean): GrantRow[] {
  return apps.map((app) => ({
    id: app.name,
    label: app.label,
    note: appNote(app),
    title: app.name,
    ...(grouped ? { group: app.installed ? t("apps.access.installed") : t("apps.access.available") } : {}),
  }));
}

function appRules(
  apps: AccessApp[],
  servers: McpServerSummary[],
  instances: InstanceInfo[],
  onToggle: (app: AccessApp, bot: Bot, on: boolean) => void,
): GrantRules {
  const byName = new Map(apps.map((app) => [app.name, app] as const));
  return {
    isOn: (row, bot) => botHasApp(bot, servers, row.id),
    lockFor: (_row, bot) => lockText(accessLockReason(bot, instances)),
    onToggle: (row, bot, on) => onToggle(byName.get(row.id)!, bot, on),
    toggleLabel: (row, bot) => t("apps.access.toggle", { bot: bot.name, app: row.label }),
  };
}

/** Apps × bots. Wide fleets scroll sideways under a pinned app column. */
export function AccessMatrix({ apps, bots, servers, instances, onToggle }: {
  apps: AccessApp[];
  bots: Bot[];
  servers: McpServerSummary[];
  instances: InstanceInfo[];
  onToggle: (app: AccessApp, bot: Bot, on: boolean) => void;
}) {
  return <GrantMatrix rows={appRows(apps, true)} bots={bots} rules={appRules(apps, servers, instances, onToggle)} rowColumnTitle={t("apps.access.appColumn")} />;
}

/** One bot's apps, and on request the tools the bot's next turn will have. */
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
  const rules = appRules(apps, servers, instances, onToggle);
  return (
    <GrantBotView
      bot={bot}
      rows={appRows(apps, false)}
      rules={rules}
      summary={t("apps.access.botCount", { count: botAppCount(bot, servers) })}
      onTitle={t("apps.access.onForBot")}
      offTitle={t("apps.access.offForBot")}
      lockText={lockText(accessLockReason(bot, instances))}
      detail={{
        buttonLabel: t("apps.access.showTools"),
        loadingLabel: t("apps.access.toolsLoading"),
        state: toolsState,
        errorText: t("apps.access.toolsFailed", { error: "" }),
        onLoad: onShowTools,
        renderRow: (row) => {
          const listed = tools?.servers.find((server) => server.name === row.id);
          if (!listed) return null;
          return (
            <div data-grant-detail={row.id} className="mt-2 text-[12px] text-ink-secondary">
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
          );
        },
      }}
    />
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
    return api(`/api/bots/${forBot}/mcp-tools`, { method: "POST", body: "{}" })
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
      <GrantManagerHeader
        titleId="access-title"
        title={t("apps.access.title")}
        intro={t("apps.access.intro")}
        view={view === "app" ? "row" : "bot"}
        onView={(next) => setView(next === "row" ? "app" : "bot")}
        bots={bots}
        selectedId={selected?.id ?? null}
        onSelect={setBotId}
        labels={{ byRow: t("apps.access.byApp"), byBot: t("apps.access.byBot"), viewAria: t("apps.access.viewAria"), pickBot: t("apps.access.pickBot") }}
      />
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

// Plugins tab of the Apps pop-up: plugin marketplaces (the Claude Code plugin
// format ZCode and Codex share), the plugins installed here, and the ones each
// harness on this machine already has. Any of them can be given to every bot
// or to chosen bots; the server turns a plugin's skills and MCP servers into
// that bot's own (server/plugin-marketplace.ts).
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { BotAvatar } from "./Avatar";

/** Same disc size as the Apps grid's "used by" avatars. */
const USED_BY_AVATAR_SIZE = 16;

type Origin = "omb" | "claude" | "codex" | "zcode";
type Access = "off" | "all" | string[];

export interface PluginRow {
  key: string;
  origin: Origin;
  name: string;
  marketplace: string;
  version: string;
  description?: string;
  skills: Array<{ name: string; description: string }>;
  mcpServers: string[];
  unsupported: string[];
  access: Access;
  usable: boolean;
}

interface Marketplace { id: string; name: string; description?: string; lastUpdated: string }
interface Suggested { origin: Origin; name: string; input: string }
interface CatalogEntry {
  name: string;
  description?: string;
  version?: string;
  category?: string;
  author?: string;
  installable: boolean;
  installed: boolean;
}

const ORIGIN_LABEL: Record<Origin, LocaleKey> = {
  omb: "plugins.origin.omb",
  claude: "plugins.origin.claude",
  codex: "plugins.origin.codex",
  zcode: "plugins.origin.zcode",
};

/** Bots a plugin reaches, in the order the sidebar shows them. */
export function botsWithPlugin(bots: Bot[], access: Access): Bot[] {
  if (access === "off") return [];
  return bots.filter((bot) => !bot.hidden && (access === "all" || access.includes(bot.id)));
}

export function PluginMarketplacePanel({ search }: { search: string }) {
  const { state } = useStore();
  const [plugins, setPlugins] = useState<PluginRow[] | null>(null);
  const [marketplaces, setMarketplaces] = useState<Marketplace[]>([]);
  const [suggested, setSuggested] = useState<Suggested[]>([]);
  const [origin, setOrigin] = useState<Origin | "all">("all");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Record<string, CatalogEntry[]>>({});
  const [choosing, setChoosing] = useState<string | null>(null);

  const load = useCallback(() => {
    return api("/api/plugins")
      .then((response) => {
        setPlugins(response.plugins ?? []);
        setMarketplaces(response.marketplaces ?? []);
        setSuggested(response.suggestedMarketplaces ?? []);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, work: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await work();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const loadCatalog = (id: string) =>
    api(`/api/plugins/marketplaces/${encodeURIComponent(id)}/catalog`)
      .then((response) => setCatalog((current) => ({ ...current, [id]: response.plugins ?? [] })))
      .catch((e: Error) => setError(e.message));

  const toggleMarketplace = (id: string) => {
    const next = open === id ? null : id;
    setOpen(next);
    if (next) void loadCatalog(next);
  };

  const setAccess = (key: string, access: Access) =>
    act(key, () => api("/api/plugins/access", { method: "PUT", body: JSON.stringify({ key, access }) }));

  const addMarketplace = (input: string) =>
    act("add-marketplace", async () => {
      await api("/api/plugins/marketplaces", { method: "POST", body: JSON.stringify({ source: input }) });
      setSource("");
    });

  const install = (marketplace: string, name: string) =>
    act(`install:${marketplace}:${name}`, async () => {
      await api("/api/plugins/install", { method: "POST", body: JSON.stringify({ marketplace, name }) });
      await loadCatalog(marketplace);
    });

  const needle = search.trim().toLowerCase();
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle);
  const rows = (plugins ?? [])
    .filter((plugin) => origin === "all" || plugin.origin === origin)
    .filter((plugin) => matches(`${plugin.name} ${plugin.marketplace} ${plugin.description ?? ""}`))
    .sort((a, b) => Number(b.access !== "off") - Number(a.access !== "off") || a.name.localeCompare(b.name));
  const counts = (plugins ?? []).reduce<Record<string, number>>((acc, plugin) => {
    acc[plugin.origin] = (acc[plugin.origin] ?? 0) + 1;
    return acc;
  }, {});
  const added = new Set(marketplaces.map((entry) => entry.name));
  const offered = suggested.filter((entry, index, all) =>
    !added.has(entry.name) && all.findIndex((other) => other.input === entry.input) === index);
  const visibleBots = state.bots.filter((bot) => !bot.hidden);

  return (
    <div data-plugin-marketplace className="flex flex-col gap-8 pt-3">
      {error && (
        <div role="alert" className="rounded-xl bg-red-500/10 px-4 py-2.5 text-[12.5px] text-red-600 dark:text-red-300">{error}</div>
      )}

      <section aria-labelledby="plugins-installed-title">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 id="plugins-installed-title" className="text-[12px] font-medium text-ink-secondary">{t("plugins.installed.title")}</h3>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("plugins.origin.filter")}>
            {(["all", "omb", "claude", "codex", "zcode"] as const).map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={origin === id}
                onClick={() => setOrigin(id)}
                className={cn(
                  "rounded-full px-3 py-1 text-[12px] font-medium transition-colors",
                  origin === id ? "bg-accent text-accent-ink" : "bg-control/70 text-ink-secondary hover:bg-raised-hover hover:text-ink",
                )}
              >
                {id === "all" ? t("apps.filter.all") : t(ORIGIN_LABEL[id])}
                {id !== "all" && counts[id] ? ` ${counts[id]}` : ""}
              </button>
            ))}
          </div>
        </div>
        <p className="mb-3 text-[12.5px] text-ink-secondary">{t("plugins.installed.help")}</p>
        {plugins === null ? (
          <div className="flex items-center gap-2 py-10 text-[13px] text-ink-secondary">
            <Loader2 size={14} className="animate-spin" /> {t("plugins.loading")}
          </div>
        ) : rows.length === 0 ? (
          <div className="py-8 text-center text-[13px] text-ink-secondary">{t("plugins.installed.empty")}</div>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((plugin) => renderPlugin(plugin))}
          </ul>
        )}
      </section>

      <section aria-labelledby="plugins-marketplaces-title" className="border-t border-hairline/30 pt-6">
        <h3 id="plugins-marketplaces-title" className="mb-1 text-[12px] font-medium text-ink-secondary">{t("plugins.marketplaces.title")}</h3>
        <p className="mb-3 text-[12.5px] text-ink-secondary">{t("plugins.marketplaces.help")}</p>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (source.trim()) void addMarketplace(source.trim());
          }}
        >
          <input
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder={t("plugins.marketplaces.placeholder")}
            aria-label={t("plugins.marketplaces.placeholder")}
            className="h-10 min-w-0 flex-1 rounded-xl bg-control/70 px-3.5 text-[13.5px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
          <button
            type="submit"
            disabled={!source.trim() || busy === "add-marketplace"}
            className="flex items-center gap-1.5 rounded-xl bg-ink px-4 text-[13px] font-medium text-app disabled:opacity-50"
          >
            {busy === "add-marketplace" ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            {t("plugins.marketplaces.add")}
          </button>
        </form>
        {offered.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-secondary">
            <span>{t("plugins.marketplaces.suggested")}</span>
            {offered.map((entry) => (
              <button
                key={`${entry.origin}:${entry.input}`}
                type="button"
                disabled={busy === "add-marketplace"}
                onClick={() => void addMarketplace(entry.input)}
                title={entry.input}
                className="rounded-full bg-control/70 px-3 py-1 font-medium text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                + {entry.name} <span className="font-normal text-ink-secondary">· {t(ORIGIN_LABEL[entry.origin])}</span>
              </button>
            ))}
          </div>
        )}
        <ul className="mt-4 flex flex-col gap-2">
          {marketplaces.map((entry) => renderMarketplace(entry))}
        </ul>
      </section>
    </div>
  );

  function renderPlugin(plugin: PluginRow) {
    const reached = botsWithPlugin(state.bots, plugin.access);
    const mode = plugin.access === "off" ? "off" : plugin.access === "all" ? "all" : "some";
    const isBusy = busy === plugin.key;
    const chosen = Array.isArray(plugin.access) ? plugin.access : [];
    return (
      <li key={plugin.key} data-plugin-key={plugin.key} className="rounded-2xl bg-control/50 px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[14px] font-medium text-ink">{plugin.name}</span>
              <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] font-medium text-ink-secondary">{t(ORIGIN_LABEL[plugin.origin])}</span>
              <span className="text-[11.5px] text-ink-secondary">{plugin.marketplace}{plugin.version ? ` · ${plugin.version}` : ""}</span>
            </div>
            {plugin.description && <p className="mt-1 line-clamp-2 text-[12.5px] text-ink-secondary">{plugin.description}</p>}
            <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11.5px]">
              {plugin.skills.length > 0 && (
                <span className="rounded-full bg-raised px-2 py-0.5 text-ink" title={plugin.skills.map((skill) => skill.name).join(", ")}>
                  {t("plugins.skills", { count: plugin.skills.length })}
                </span>
              )}
              {plugin.mcpServers.length > 0 && (
                <span className="rounded-full bg-raised px-2 py-0.5 text-ink" title={plugin.mcpServers.join(", ")}>
                  {t("plugins.mcpServers", { count: plugin.mcpServers.length })}
                </span>
              )}
              {plugin.unsupported.map((part) => (
                <span key={part} className="rounded-full border border-hairline/50 px-2 py-0.5 text-ink-secondary" title={t("plugins.unsupportedTitle")}>
                  {t("plugins.unsupported", { part })}
                </span>
              ))}
              {!plugin.usable && <span className="px-1 text-ink-secondary">{t("plugins.nothingUsable")}</span>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {reached.length > 0 && (
              <span className="flex -space-x-1.5" role="img" aria-label={t("apps.usedBy", { names: reached.map((bot) => bot.name).join(", ") })}>
                {reached.slice(0, 3).map((bot) => (
                  <span key={bot.id} className="flex size-5 items-center justify-center overflow-hidden rounded-full bg-menu ring-2 ring-menu">
                    <BotAvatar bot={bot} size={USED_BY_AVATAR_SIZE} animated={false} />
                  </span>
                ))}
              </span>
            )}
            <select
              aria-label={t("plugins.access.label", { name: plugin.name })}
              value={choosing === plugin.key ? "some" : mode}
              disabled={isBusy || !plugin.usable}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "some") {
                  setChoosing(plugin.key);
                  return;
                }
                setChoosing(null);
                void setAccess(plugin.key, value as "off" | "all");
              }}
              className="h-8 rounded-lg bg-raised px-2 text-[12.5px] text-ink disabled:opacity-50"
            >
              <option value="off">{t("plugins.access.off")}</option>
              <option value="all">{t("plugins.access.all")}</option>
              <option value="some">{t("plugins.access.some")}</option>
            </select>
            {plugin.origin === "omb" && (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => {
                  if (window.confirm(t("plugins.uninstallConfirm", { name: plugin.name }))) {
                    void act(plugin.key, () => api("/api/plugins/uninstall", { method: "POST", body: JSON.stringify({ key: plugin.key }) }));
                  }
                }}
                aria-label={t("plugins.uninstall", { name: plugin.name })}
                className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
              >
                <Trash2 size={15} />
              </button>
            )}
            {isBusy && <Loader2 size={14} className="animate-spin text-ink-secondary" />}
          </div>
        </div>
        {(mode === "some" || choosing === plugin.key) && (
          <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label={t("plugins.access.choose")}>
            {visibleBots.map((bot) => {
              const on = chosen.includes(bot.id);
              return (
                <button
                  key={bot.id}
                  type="button"
                  aria-pressed={on}
                  disabled={isBusy}
                  onClick={() => {
                    const next = on ? chosen.filter((id) => id !== bot.id) : [...chosen, bot.id];
                    if (next.length) setChoosing(null);
                    void setAccess(plugin.key, next.length ? next : "off");
                  }}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2.5 text-[12px] font-medium transition-colors",
                    on ? "bg-accent text-accent-ink" : "bg-raised text-ink hover:bg-raised-hover",
                  )}
                >
                  <span className="flex size-5 items-center justify-center overflow-hidden rounded-full bg-menu">
                    <BotAvatar bot={bot} size={USED_BY_AVATAR_SIZE} animated={false} />
                  </span>
                  {bot.name}
                </button>
              );
            })}
          </div>
        )}
      </li>
    );
  }

  function renderMarketplace(entry: Marketplace) {
    const expanded = open === entry.id;
    const items = (catalog[entry.id] ?? []).filter((item) => matches(`${item.name} ${item.description ?? ""} ${item.category ?? ""}`));
    return (
      <li key={entry.id} data-marketplace={entry.id} className="rounded-2xl bg-control/50">
        <div className="flex items-center gap-2 px-4 py-3">
          <button type="button" onClick={() => toggleMarketplace(entry.id)} aria-expanded={expanded} className="flex min-w-0 flex-1 items-center gap-2 text-left">
            {expanded ? <ChevronDown size={15} className="shrink-0 text-ink-secondary" /> : <ChevronRight size={15} className="shrink-0 text-ink-secondary" />}
            <span className="min-w-0">
              <span className="block text-[14px] font-medium text-ink">{entry.name}</span>
              {entry.description && <span className="block truncate text-[12px] text-ink-secondary">{entry.description}</span>}
            </span>
          </button>
          <button
            type="button"
            disabled={busy === `refresh:${entry.id}`}
            onClick={() => void act(`refresh:${entry.id}`, async () => {
              await api(`/api/plugins/marketplaces/${encodeURIComponent(entry.id)}/refresh`, { method: "POST" });
              if (expanded) await loadCatalog(entry.id);
            })}
            aria-label={t("plugins.marketplaces.refresh", { name: entry.name })}
            className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
          >
            <RefreshCw size={15} className={cn(busy === `refresh:${entry.id}` && "animate-spin")} />
          </button>
          <button
            type="button"
            disabled={busy === `remove:${entry.id}`}
            onClick={() => {
              if (window.confirm(t("plugins.marketplaces.removeConfirm", { name: entry.name }))) {
                void act(`remove:${entry.id}`, () => api(`/api/plugins/marketplaces/${encodeURIComponent(entry.id)}`, { method: "DELETE" }));
              }
            }}
            aria-label={t("plugins.marketplaces.remove", { name: entry.name })}
            className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
          >
            <Trash2 size={15} />
          </button>
        </div>
        {expanded && (
          <div className="border-t border-hairline/30 px-4 py-3">
            {!catalog[entry.id] ? (
              <div className="flex items-center gap-2 text-[12.5px] text-ink-secondary"><Loader2 size={13} className="animate-spin" /> {t("plugins.loading")}</div>
            ) : items.length === 0 ? (
              <div className="text-[12.5px] text-ink-secondary">{t("connectors.noAppsFound")}</div>
            ) : (
              <ul className="grid grid-cols-1 gap-2 @lg:grid-cols-2">
                {items.map((item) => {
                  const id = `install:${entry.id}:${item.name}`;
                  return (
                    <li key={item.name} className="flex items-start justify-between gap-3 rounded-xl bg-raised/60 px-3 py-2.5">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-ink">
                          {item.name}
                          {item.version && <span className="ml-1.5 text-[11.5px] font-normal text-ink-secondary">{item.version}</span>}
                        </div>
                        {item.description && <p className="mt-0.5 line-clamp-2 text-[12px] text-ink-secondary">{item.description}</p>}
                      </div>
                      <button
                        type="button"
                        disabled={item.installed || !item.installable || busy === id}
                        onClick={() => void install(entry.id, item.name)}
                        title={!item.installable ? t("plugins.notInstallable") : undefined}
                        className="flex shrink-0 items-center gap-1 rounded-lg bg-ink px-2.5 py-1 text-[12px] font-medium text-app disabled:bg-raised disabled:text-ink-secondary"
                      >
                        {busy === id && <Loader2 size={12} className="animate-spin" />}
                        {item.installed ? t("plugins.installedBadge") : item.installable ? t("plugins.install") : t("plugins.unavailable")}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </li>
    );
  }
}

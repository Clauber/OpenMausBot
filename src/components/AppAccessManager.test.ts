import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";

vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ state: { bots: [], instances: [] }, dispatch: vi.fn() }) }));
vi.mock("./Avatar", () => ({ BotAvatar: ({ bot }: { bot: Bot }) => createElement("span", { "data-avatar": bot.id }) }));
import { AccessMatrix, BotAppsView } from "./AppAccessManager";
import { buildAccessApps, type CatalogApp } from "@/lib/mcp-access";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void; [key: string]: unknown }>;
// Components here are function components: expand them so their switches are reachable.
function expand(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    if (typeof node.type === "function") {
      const rendered = (node.type as (props: unknown) => ReactNode)(node.props);
      return [node, ...expand(rendered)];
    }
    return [node, ...expand(node.props.children)];
  });
}

const catalog: CatalogApp[] = [
  { name: "gog", label: "Gmail & Calendar", description: "", transport: "http", target: "http://gateway.example.test/mcp", installed: false, enabled: false, secrets: [{ name: "x-litellm-api-key", envKey: "GOG_GATEWAY_KEY", available: true }] },
  { name: "vault", label: "Vault", description: "", transport: "http", target: "http://gateway.example.test/mcp", installed: false, enabled: false, secrets: [{ name: "x-api-key", available: false }] },
];
const servers = [{ name: "notes", enabled: true }, { name: "scratch", enabled: false }];
const apps = buildAccessApps(servers, catalog);
const bot = (id: string, fields: Partial<Bot> = {}) => ({ id, name: `Bot ${id}`, hidden: false, modelSelection: { instanceId: "claude" }, ...fields }) as unknown as Bot;
const instances = [{ instanceId: "claude", capabilities: { customMcp: true } }] as unknown as InstanceInfo[];
const bots = [bot("alpha", { mcpServers: ["notes"] }), bot("beta", { mcpServers: [] }), bot("gamma", { busy: true })];

describe("access matrix", () => {
  const onToggle = vi.fn();
  const matrixTree = () => AccessMatrix({ apps, bots, servers, instances, onToggle });
  const html = renderToStaticMarkup(createElement(AccessMatrix, { apps, bots, servers, instances, onToggle }));

  it("lists installed and available apps down the side and every bot across the top", () => {
    for (const name of ["notes", "scratch", "gog", "vault"]) expect(html).toContain(`data-access-row="${name}"`);
    for (const id of ["alpha", "beta", "gamma"]) expect(html).toContain(`data-access-bot="${id}"`);
    expect(html.indexOf('data-access-row="notes"')).toBeLessThan(html.indexOf('data-access-row="gog"'));
    expect(html).toContain("Installed");
    expect(html).toContain("Available to install");
  });

  it("shows each cell's grant from the bot's own list", () => {
    const on = (cell: string) => new RegExp(`aria-checked="true"[^>]*data-access-cell="${cell}"|data-access-cell="${cell}"[^>]*aria-checked="true"`).test(html);
    expect(on("notes:alpha")).toBe(true);
    expect(on("notes:beta")).toBe(false);
    expect(on("gog:alpha")).toBe(false);
  });

  it("says what turning an app on will do", () => {
    expect(html).toContain("Not installed. Turning it on for a bot installs it.");
    expect(html).toContain("Needs x-api-key to install.");
    expect(html).toContain("Switched off in MCP servers.");
  });

  it("calls the toggle with the app, the bot and the new state; a working bot's switch is locked", () => {
    const cells = expand(matrixTree().props.children).filter((node) => typeof node.props["data-access-cell"] === "string");
    const cell = (id: string) => cells.find((node) => node.props["data-access-cell"] === id)!;
    cell("gog:alpha").props.onClick!();
    expect(onToggle).toHaveBeenLastCalledWith(expect.objectContaining({ name: "gog" }), expect.objectContaining({ id: "alpha" }), true);
    cell("notes:alpha").props.onClick!();
    expect(onToggle).toHaveBeenLastCalledWith(expect.objectContaining({ name: "notes" }), expect.objectContaining({ id: "alpha" }), false);
    expect(cell("gog:gamma").props.disabled).toBe(true);
    expect(cell("gog:alpha").props.disabled).toBe(false);
  });

  it("never renders a credential: only names of what is missing", () => {
    expect(html).not.toMatch(/sk-|Bearer|GOG_GATEWAY_KEY/);
  });
});

describe("a bot's apps", () => {
  const view = (toolsState: "idle" | "loading" | "error", tools: Parameters<typeof BotAppsView>[0]["tools"]) => renderToStaticMarkup(createElement(BotAppsView, {
    bot: bots[0]!, apps, servers, instances, tools, toolsState, onToggle: vi.fn(), onShowTools: vi.fn(),
  }));

  it("splits the apps into on and off for that bot and counts them", () => {
    const html = view("idle", null);
    expect(html).toContain("Apps on: 1");
    expect(html.indexOf("On for this bot")).toBeLessThan(html.indexOf('data-bot-app="notes"'));
    expect(html.indexOf('data-bot-app="notes"')).toBeLessThan(html.indexOf("Off for this bot"));
    expect(html.indexOf("Off for this bot")).toBeLessThan(html.indexOf('data-bot-app="gog"'));
  });

  it("lists the tools of apps the bot has, and none for apps it does not", () => {
    const html = view("idle", { servers: [
      { name: "notes", ok: true, tools: [{ name: "read_notes" }] },
      { name: "gog", ok: true, tools: [{ name: "gmail_search" }] },
    ] });
    expect(html).toContain('data-bot-app-tools="notes"');
    expect(html).toContain("read_notes");
    expect(html).not.toContain("gmail_search");
  });

  it("reports an app whose tools could not be listed", () => {
    const html = view("idle", { servers: [{ name: "notes", ok: false, tools: [], error: "The server returned HTTP 401." }] });
    expect(html).toContain("Could not list tools: The server returned HTTP 401.");
  });
});

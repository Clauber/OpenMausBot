// ZCode driver — the `zcode` CLI headless over its app-server ("ZCode
// Protocol") transport: newline-delimited JSON on stdio, plain
// {id, method, params} envelopes (no `jsonrpc` field). Verified against the
// open-source tree (github.com/zai-org/ZCode, packages/shared/src/
// zcode-protocol + apps/zcode-cli/packages/bootstrap/src/zcode-protocol)
// and against a live app-server: the legacy session/* surface is still
// served alongside the v4 conversation channel, and is what this driver
// speaks. One app-server process per turn, like codex: session/create (or
// session/resume on the resumeCursor = zcode session id), session/subscribe,
// then session/send. Completion is the `turn.completed` session event (usage
// rides its payload); `turn.failed` settles the turn with its error.
// Permission asks arrive as server→client `interaction/requestPermission`
// requests answered with {decision} — the wire answer must be one of the
// request's own options (each option carries its exact response payload),
// so Full access only ever echoes an allow option the CLI itself offered; a
// synthesised `{decision:"allow"}` without one fails closed into a card.
//
// MCP integrations ride session params (mcpServers), not argv: harness-owned
// stdio/HTTP servers merge over the person's own zcode config servers by
// name. Models: the protocol serves only the current selection's settings
// state (the full market never crosses the wire), so the catalog comes from
// a throwaway deferred session's subscribe snapshot and a turn's model is
// reasserted each turn via create params or session/setModel — ids are the
// CLI's own picker format `provider/model[$reasoning-level]`, and a model
// that requires a reasoning level rejects setModel without one. There is no
// machine-readable sign-in status, so the snapshot infers auth from the
// credential files `zcode login` writes.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DATA_DIR, stripWorkspaceCredentialEnv } from "../config.ts";
import { augmentedPath } from "../env-path.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";
import { isHarnessOwnedMcpEnvName } from "../mcp-registry.ts";
import { appendNative } from "./native.ts";
import { classifyError } from "./retry.ts";
import { commandSummary, toolDetailPreview } from "../tool-summary.ts";
import { gateServer } from "../mcp-gate-config.ts";
import { canUseMcpServer } from "../../shared/tool-scope.ts";
import { assertToolScopeSupported } from "../../shared/tool-scope-support.ts";
import { announcesAction, CONTINUATION_NUDGE } from "./announced-action.ts";
import type { ApprovalMode } from "../../shared/approval-mode.ts";

// session/create alone takes 7–9 s on a healthy host, longer while other
// engines start; the 8 s RPC default lost that race and left the catalog empty.
const PROBE_SESSION_TIMEOUT_MS = 45_000;
const PROBE_ATTEMPTS = 3;
const PROBE_RETRY_MS = 30_000;

const DENY_TIMEOUT_NOTE =
  "OpenMausBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";

import type {
  DriverCreateInput,
  McpServerSpec,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  SteerOutcome,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";

const DRIVER_KIND = "zcodeAgent";

export interface ZcodeConfig {
  cli: string;
}

function decodeConfig(raw: unknown): ZcodeConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return { cli: typeof o.cli === "string" && o.cli.trim() ? o.cli : "zcode" };
}

/** Fallback when the catalog probe cannot run: the engine runs whatever
 * model its own settings selected (`zcode /model`). */
const FALLBACK_ZCODE_MODELS: ModelCatalog = {
  default: "agent-default",
  options: [{ id: "agent-default", label: "Agent default" }],
};

/** OMB approval levels → zcode permission modes. Ask and Auto both run
 * `build` (read-only tools run, risky ones ask — the harness's safe-Auto
 * rules answer the safe ones); Edits runs `edit`; Full access runs `yolo`. */
export function zcodePermissionMode(mode: ApprovalMode): "build" | "edit" | "yolo" {
  if (mode === "full") return "yolo";
  if (mode === "edits") return "edit";
  return "build";
}

/** The protocol's workspace ref. `workspaceKey` is client-chosen and opaque
 * on the wire; the CLI's own builder (bootstrap/zcode-protocol/workspace.ts,
 * buildWorkspaceRef) derives it as `workspaceIdentity ?? workspacePath`, so
 * the driver does the same to keep OMB-created sessions grouped with the
 * same workspace in zcode's own state. (An earlier sha256-truncated key was
 * a memory-slug derivation, not this field.) */
export function zcodeWorkspaceRef(workspacePath: string, workspaceIdentity?: string): {
  workspacePath: string;
  workspaceKey: string;
  workspaceIdentity?: string;
} {
  const identity = workspaceIdentity?.trim() || undefined;
  return {
    workspacePath,
    workspaceKey: identity ?? workspacePath,
    ...(identity ? { workspaceIdentity: identity } : {}),
  };
}

/** OMB model id for a zcode ModelSelection — the CLI's own picker format
 * (model-selection.ts formatModelPickerValue): `provider/model` with the
 * reasoning level appended after `$` when the model needs one. Models whose
 * registry requires a reasoning level reject `session/setModel` without it
 * ("Reasoning level is required for …"), so a default level is always baked
 * into the id when the catalog advertises levels. */
export function zcodeModelId(
  selection: { providerId?: unknown; modelId?: unknown },
  reasoningLevel?: unknown,
): string | null {
  if (typeof selection?.providerId !== "string" || !selection.providerId.trim()) return null;
  if (typeof selection?.modelId !== "string" || !selection.modelId.trim()) return null;
  const level = typeof reasoningLevel === "string" && reasoningLevel.trim() ? reasoningLevel.trim() : undefined;
  return `${selection.providerId}/${selection.modelId}${level ? `$${level}` : ""}`;
}

/** Reverse of zcodeModelId for a turn's model choice. Null when the id is
 * not a provider-qualified selection (never silently mapped to a model).
 * The provider id ends at the FIRST slash — personal model ids may carry
 * their own slashes (AvelloCC's "kiro/claude-opus-5"). */
export function zcodeParseModelId(id: string): {
  providerId: string;
  modelId: string;
  options?: { reasoningLevel: string };
} | null {
  const dollar = id.indexOf("$");
  const base = dollar === -1 ? id : id.slice(0, dollar);
  const level = dollar === -1 ? undefined : id.slice(dollar + 1);
  if (dollar !== -1 && (!level || level.includes("/") || level.includes("$"))) return null;
  const slash = base.indexOf("/");
  if (slash <= 0 || slash === base.length - 1) return null;
  const providerId = base.slice(0, slash);
  const modelId = base.slice(slash + 1);
  return {
    providerId,
    modelId,
    ...(level ? { options: { reasoningLevel: level } } : {}),
  };
}

// ── personal provider config ───────────────────────────────────────────
// The engine's registry = its builtin providers + ONE personal provider
// config: the ZCODE_PERSONAL_PROVIDER_CONFIG_FILE env path, else
// `<dataBase>/.zcode/v2/provider_config.json` (provider-runtime-env.ts) —
// and Clauber's headless wrapper overrides that env with its own file.
// Only the current model ever crosses the protocol wire, so the catalog's
// custom models come from these files: the driver merges every config it
// can find into one file under its own data dir and points its children
// at it, so all of the person's providers exist in the child registry.

export interface ZcodePersonalProviderConfig {
  schemaVersion?: unknown;
  config?: {
    providerOrder?: unknown;
    providerConfigRules?: { providerRules?: Array<{
      providerId?: unknown;
      providerName?: unknown;
      enabled?: unknown;
      config?: { personalModelIds?: unknown; modelOrder?: unknown };
    }> };
    modelConfigRules?: {
      providerModelRules?: Array<{
        providerId?: unknown;
        modelId?: unknown;
        config?: { properties?: { contextWindow?: unknown } };
      }>;
      manualProviderModelRules?: Array<{ providerId?: unknown; modelId?: unknown }>;
    };
  };
}

/** Where a personal provider config may live, most specific first: the
 * env override, then the CLI's v2 default, then the headless wrapper's
 * file. Only existing paths are returned. */
export function zcodePersonalConfigCandidates(
  env: Record<string, string | undefined>,
  home: string,
): string[] {
  const dataBase = env.ZCODE_DATA_BASE_DIR?.trim() || home;
  const candidates = [
    env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim(),
    join(dataBase, ".zcode", "v2", "provider_config.json"),
    join(home, ".zcode", "headless", "provider_config.json"),
  ].filter((p): p is string => Boolean(p && p.trim()));
  return [...new Set(candidates)].filter((p) => existsSync(p));
}

function readPersonalConfig(path: string): ZcodePersonalProviderConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && (parsed as ZcodePersonalProviderConfig).config) return parsed;
  } catch { /* an unreadable config is skipped, never fatal */ }
  return null;
}

/** Merge personal configs into one document: provider rules and model
 * rules concatenate with first-file-wins dedupe by id; the first file's
 * providerOrder is kept and later providers append. */
export function zcodeMergePersonalConfigs(docs: ZcodePersonalProviderConfig[]): ZcodePersonalProviderConfig | null {
  const rules: NonNullable<NonNullable<ZcodePersonalProviderConfig["config"]>["providerConfigRules"]>["providerRules"] = [];
  const seenProviders = new Set<string>();
  const modelRules: NonNullable<NonNullable<ZcodePersonalProviderConfig["config"]>["modelConfigRules"]>["providerModelRules"] = [];
  const manualModelRules: NonNullable<NonNullable<ZcodePersonalProviderConfig["config"]>["modelConfigRules"]>["manualProviderModelRules"] = [];
  const seenModels = new Set<string>();
  const providerOrder: string[] = [];
  let schemaVersion: unknown = 1;
  for (const doc of docs) {
    if (doc.schemaVersion !== undefined) schemaVersion = doc.schemaVersion;
    const config = doc.config ?? {};
    if (Array.isArray(config.providerOrder)) {
      for (const id of config.providerOrder) {
        if (typeof id === "string" && !providerOrder.includes(id)) providerOrder.push(id);
      }
    }
    for (const rule of config.providerConfigRules?.providerRules ?? []) {
      const id = typeof rule?.providerId === "string" ? rule.providerId : null;
      if (!id || seenProviders.has(id)) continue;
      seenProviders.add(id);
      rules.push(rule);
    }
    for (const rule of config.modelConfigRules?.providerModelRules ?? []) {
      const key = `${String(rule?.providerId)}\u0000${String(rule?.modelId)}`;
      if (!rule || seenModels.has(key)) continue;
      seenModels.add(key);
      modelRules.push(rule);
    }
    for (const rule of config.modelConfigRules?.manualProviderModelRules ?? []) {
      const key = `manual\u0000${String(rule?.providerId)}\u0000${String(rule?.modelId)}`;
      if (!rule || seenModels.has(key)) continue;
      seenModels.add(key);
      manualModelRules.push(rule);
    }
  }
  if (!rules.length) return null;
  return {
    schemaVersion,
    config: {
      providerOrder,
      providerConfigRules: { providerRules: rules },
      // The CLI's on-disk schema is strict: manualProviderModelRules is
      // required alongside providerModelRules, and a missing key rejects
      // the whole file.
      modelConfigRules: { providerModelRules: modelRules, manualProviderModelRules: manualModelRules },
    },
  };
}

/** Every selectable model a merged personal config declares, in
 * providerOrder then modelOrder: the catalog's candidate list. */
export function zcodeConfigModels(merged: ZcodePersonalProviderConfig): Array<{
  providerId: string;
  providerName: string;
  modelId: string;
  contextWindow?: number;
}> {
  const config = merged.config ?? {};
  const rulesById = new Map<string, { name: string; enabled: boolean; modelIds: string[] }>();
  for (const rule of config.providerConfigRules?.providerRules ?? []) {
    const id = typeof rule?.providerId === "string" ? rule.providerId : null;
    if (!id) continue;
    const personal = Array.isArray(rule.config?.personalModelIds)
      ? rule.config.personalModelIds.filter((m): m is string => typeof m === "string")
      : [];
    const ordered = Array.isArray(rule.config?.modelOrder)
      ? rule.config.modelOrder.filter((m): m is string => typeof m === "string")
      : [];
    rulesById.set(id, {
      name: typeof rule.providerName === "string" && rule.providerName ? rule.providerName : id,
      enabled: rule.enabled !== false,
      modelIds: [...new Set([...ordered, ...personal])],
    });
  }
  const contextByModel = new Map<string, number>();
  for (const rule of config.modelConfigRules?.providerModelRules ?? []) {
    if (typeof rule?.providerId !== "string" || typeof rule?.modelId !== "string") continue;
    const window = rule.config?.properties?.contextWindow;
    if (typeof window === "number" && window > 0) contextByModel.set(`${rule.providerId}\u0000${rule.modelId}`, window);
  }
  const order = [...(Array.isArray(config.providerOrder) ? config.providerOrder : []).filter((id): id is string => typeof id === "string"), ...rulesById.keys()];
  const rows: Array<{ providerId: string; providerName: string; modelId: string; contextWindow?: number }> = [];
  const seen = new Set<string>();
  for (const providerId of order) {
    const provider = rulesById.get(providerId);
    if (!provider || !provider.enabled) continue;
    for (const modelId of provider.modelIds) {
      const key = `${providerId}\u0000${modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        providerId,
        providerName: provider.name,
        modelId,
        ...(contextByModel.has(key) ? { contextWindow: contextByModel.get(key) } : {}),
      });
    }
  }
  return rows;
}

/** Model rows from a snapshot's settings state. The wire serves only the
 * current model (`modelAvailability: "current"` — the full market never
 * crosses the protocol), so the catalog shows what the engine will actually
 * run; multi-model installs get their other models through zcode itself. */
export function zcodeCatalogFromSnapshot(settings: {
  model?: {
    current?: { providerId?: unknown; modelId?: unknown; options?: { reasoningLevel?: unknown } };
    available?: Array<{
      ref?: { providerId?: unknown; modelId?: unknown };
      label?: unknown;
      providerLabel?: unknown;
      contextWindow?: unknown;
      reasoning?: { levels?: Array<{ value?: unknown }>; defaultLevel?: unknown };
    }>;
  };
}): ModelCatalog {
  const rows: NonNullable<ModelCatalog["options"]> = [];
  const seen = new Set<string>();
  for (const option of Array.isArray(settings.model?.available) ? settings.model!.available! : []) {
    const id = zcodeModelId(option.ref ?? {}, option.reasoning?.defaultLevel ?? option.reasoning?.levels?.[0]?.value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      label: typeof option.label === "string" && option.label ? option.label : id,
      provider: typeof option.ref?.providerId === "string" ? option.ref.providerId : undefined,
      ...(typeof option.contextWindow === "number" && option.contextWindow > 0 ? { contextWindow: option.contextWindow } : {}),
    });
  }
  const current = settings.model?.current;
  if (current) {
    const id = zcodeModelId(current, current.options?.reasoningLevel);
    if (id && !seen.has(id)) {
      seen.add(id);
      rows.unshift({ id, label: id, provider: typeof current.providerId === "string" ? current.providerId : undefined });
    }
  }
  if (!rows.length) return FALLBACK_ZCODE_MODELS;
  return { default: rows[0].id, options: rows };
}

/** Harness-owned servers become protocol env pairs; a user-configured
 * server keeps its env values verbatim. */
export function zcodeMcpServerParam(name: string, server: McpServerSpec): Record<string, unknown> {
  if ("url" in server) {
    return {
      name,
      type: server.type,
      url: server.url,
      headers: Object.entries(server.headers).map(([key, value]) => ({ name: key, value })),
    };
  }
  return {
    name,
    command: server.command,
    args: server.args,
    env: Object.entries(server.env).map(([key, value]) => ({ name: key, value })),
  };
}

/** The only safe Full-access answer is an option the CLI itself offered:
 * each permission option carries its exact response payload, and answering
 * with a fabricated one is a protocol guess. Null when no allow option
 * exists — the ask becomes a card instead (fail closed). */
export function zcodeAllowOption(params: {
  options?: Array<{ optionId?: unknown; kind?: unknown; name?: unknown; response?: { decision?: unknown } }>;
}): Record<string, unknown> | null {
  for (const option of Array.isArray(params.options) ? params.options : []) {
    if (option && typeof option === "object" && option.response?.decision === "allow" && typeof option.response === "object") {
      return option.response as Record<string, unknown>;
    }
  }
  return null;
}

/** A zcode permission request's input is usually the tool arguments object
 * (Bash carries `command`). Only a plain string command becomes the card's
 * exact-command line — anything else falls back to the reason text. */
export function zcodeRequestSummary(params: { toolName?: unknown; reason?: unknown; input?: unknown }): {
  tool: string;
  summary: string;
  command?: { command: string; cwd: string };
} {
  const tool = typeof params.toolName === "string" && params.toolName ? params.toolName : "tool";
  const input = params.input && typeof params.input === "object" && !Array.isArray(params.input)
    ? params.input as Record<string, unknown>
    : null;
  const rawCommand = input?.command;
  const command = typeof rawCommand === "string" && rawCommand.trim() ? rawCommand.trim() : null;
  const rawCwd = input?.cwd;
  const inputCwd = typeof rawCwd === "string" ? rawCwd : "";
  const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : "";
  return {
    tool,
    summary: (command ? commandSummary({ command }) : undefined) ?? (reason || tool),
    ...(command ? { command: { command, cwd: inputCwd } } : {}),
  };
}

export const ZcodeDriver: ProviderDriver<ZcodeConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "ZCode", supportsMultipleInstances: true },
  install: {
    signInCommand: "zcode login",
  },
  models: FALLBACK_ZCODE_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<ZcodeConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    // Merge every personal provider config this machine has into one file
    // under the harness's data dir, and point the driver's children at it:
    // the merged set — the person's own providers plus any wrapper-injected
    // ones — is what the catalog advertises and what setModel can reach.
    let personalConfigPath: string | null = null;
    try {
      const docs = zcodePersonalConfigCandidates(process.env, homedir())
        .map(readPersonalConfig)
        .filter((doc): doc is ZcodePersonalProviderConfig => doc !== null);
      const merged = zcodeMergePersonalConfigs(docs);
      if (merged) {
        const directory = join(DATA_DIR, "providers", "zcode", createHash("sha256").update(instanceId).digest("hex"));
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        personalConfigPath = join(directory, "provider_config.json");
        writeFileSync(personalConfigPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
      }
    } catch { // a broken config layout must not shadow the instance; children keep their default resolution
    }
    const childEnv = (): Record<string, string | undefined> => {
      const env: Record<string, string | undefined> = {
        ...process.env,
        ...input.environment,
        PATH: augmentedPath(),
      };
      // The harness process may hold workspace credentials; none of them are
      // this CLI's to see.
      stripWorkspaceCredentialEnv(env);
      if (personalConfigPath) env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personalConfigPath;
      return env;
    };
    const listeners = new Set<RuntimeEventListener>();
    interface Turn {
      stop: () => Promise<boolean>;
      turnId: string;
      asks: Map<string, (behavior: "allow" | "deny" | "answer", message?: string, source?: "user" | "timeout" | "system") => void>;
    }
    const active = new Map<string, Turn>();
    let disposed = false;

    const emit = (event: RuntimeEvent) => {
      for (const l of Array.from(listeners)) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    /** Best-effort sign-in inference: `zcode login` writes shared
     * credentials under the storage root, and headless installs point at a
     * provider config by environment. Neither is a status command — an
     * expired token still reports signed-in here and fails at turn time. */
    const authStatus = (env: Record<string, string | undefined>): { authenticated: boolean; hint?: string } => {
      const dataBase = env.ZCODE_DATA_BASE_DIR?.trim() || homedir();
      const storage = env.ZCODE_STORAGE_DIR?.trim() || join(homedir(), ".zcode");
      if (env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim() && existsSync(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE.trim())) return { authenticated: true };
      if (existsSync(join(dataBase, ".zcode", "v2", "credentials.json"))) return { authenticated: true };
      if (existsSync(join(storage, "v2", "credentials.json"))) return { authenticated: true };
      if (existsSync(join(storage, "v2", "provider_config.json"))) return { authenticated: true };
      return { authenticated: false, hint: "Run `zcode login` in a terminal to sign this engine in." };
    };

    /** The catalog probe: a throwaway deferred session whose subscribe
     * snapshot carries settings.model — the current selection plus its
     * reasoning levels. The protocol deliberately never serves the full
     * model market, so this shows what the engine will actually run. */
    let probeChild: ReturnType<typeof spawnCli> | null = null;
    const discoverCatalog = async (): Promise<ModelCatalog> => {
      const probeCwd = homedir();
      // The probe is driver-internal: it must not inherit the scripted-fake
      // knobs (FAKE_ZCODE_*) that tests aim at turn processes, and its dump
      // would otherwise interleave with the turn's wire log.
      const probeEnv = { ...childEnv() };
      for (const key of Object.keys(probeEnv)) {
        if (key.startsWith("FAKE_ZCODE")) delete probeEnv[key];
      }
      const child = spawnCli(config.cli, ["app-server"], {
        cwd: probeCwd,
        env: probeEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      probeChild = child;
      const done = (): void => {
        if (probeChild === child) probeChild = null;
        void killCliTree(child);
      };
      // session/create stalls until the server→client requests it raises
      // (session/requestRuntimePreferences and friends) are answered, so the
      // probe answers every one of them -32601, which switches the server to
      // its own compatibility fallback.
      const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
      let nextRequestId = 1;
      let buf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let msg: any;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.id !== undefined && msg.method) {
            try { child.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "not implemented" } }) + "\n"); } catch {}
            continue;
          }
          if (msg.id === undefined || !pending.has(msg.id)) continue;
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(String(msg.error.message ?? "zcode rpc error")));
          else p.resolve(msg.result);
        }
      });
      const request = (method: string, params: unknown, timeoutMs = 8_000) =>
        new Promise<any>((resolve, reject) => {
          const id = nextRequestId++;
          const timer = setTimeout(() => {
            if (pending.delete(id)) reject(new Error(`zcode ${method} timed out`));
          }, timeoutMs);
          timer.unref?.();
          pending.set(id, { resolve, reject, timer });
          try {
            child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
          } catch (e) {
            clearTimeout(timer);
            pending.delete(id);
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      try {
        const created = await request("session/create", {
          workspace: zcodeWorkspaceRef(probeCwd),
          mode: "build",
          persistence: "deferred",
        }, PROBE_SESSION_TIMEOUT_MS);
        const sessionId = created?.session?.sessionId;
        if (!sessionId) throw new Error("zcode did not return a session id");
        const subscribed = await request("session/subscribe", { sessionId, deliveryKind: "desktop-continuous", includeSnapshot: true }, PROBE_SESSION_TIMEOUT_MS);
        const catalog = zcodeCatalogFromSnapshot(subscribed?.snapshot?.settings ?? {});
        // The snapshot serves only the current model; the person's other
        // providers come from the merged personal config. Each candidate is
        // validated against the child's own registry with setModel — the
        // error taxonomy cleanly separates not-a-model from
        // needs-a-reasoning-level — and the winning level is baked into the
        // catalog id, since the object form of setModel rejects a missing
        // level outright.
        const rows: NonNullable<ModelCatalog["options"]> = [...catalog.options];
        const currentId = catalog.default;
        // One row per provider/model pair: the snapshot's current selection
        // (with its own default level) wins over a ladder-discovered twin.
        const seenBaseIds = new Set(rows.map((row) => row.id.replace(/\$[^$]*$/, "")));
        const candidates = personalConfigPath
          ? zcodeConfigModels(readPersonalConfig(personalConfigPath) ?? {})
          : [];
        const budget = Date.now() + 90_000;
        for (const candidate of candidates) {
          if (rows.length >= 200 || Date.now() > budget) break;
          const baseId = zcodeModelId({ providerId: candidate.providerId, modelId: candidate.modelId });
          if (!baseId || seenBaseIds.has(baseId)) continue;
          let accepted: { level?: string } | null = null;
          for (const attempt of [undefined, "high", "low", "medium", "max"] as const) {
            try {
              await request("session/setModel", {
                sessionId,
                model: { providerId: candidate.providerId, modelId: candidate.modelId, ...(attempt ? { options: { reasoningLevel: attempt } } : {}) },
                persistAsWorkspaceLastUsed: false,
              }, 6_000);
              accepted = { level: attempt };
              break;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (/不存在|not exist/i.test(message)) break; // not this registry's model — skip for good
              if (!/reasoning/i.test(message)) break; // a model that fails for another reason is not offered
              // reasoning-level-missing / -not-supported: try the next rung
            }
          }
          if (!accepted) continue;
          const id = zcodeModelId({ providerId: candidate.providerId, modelId: candidate.modelId }, accepted.level);
          if (!id || seenBaseIds.has(id.replace(/\$[^$]*$/, ""))) continue;
          seenBaseIds.add(id.replace(/\$[^$]*$/, ""));
          rows.push({
            id,
            label: candidate.modelId,
            provider: candidate.providerName,
            ...(candidate.contextWindow ? { contextWindow: candidate.contextWindow } : {}),
          });
        }
        await request("session/close", { sessionId }).catch(() => {});
        return { default: currentId, options: rows };
      } finally {
        done();
      }
    };
    let models = FALLBACK_ZCODE_MODELS;
    const refreshModels = async () => {
      // A probe that loses a race with a busy startup must not leave the
      // engine on its one-model fallback until the next restart.
      for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
        if (disposed) return;
        try {
          const discovered = await discoverCatalog();
          if (disposed) return;
          if (discovered.options.length) models = discovered;
          return;
        } catch (error) {
          // Keep the last usable catalog (or the passthrough fallback), but
          // say why — a silent fallback looks like a broken engine.
          console.error(`zcode: model catalog probe failed (attempt ${attempt}/${PROBE_ATTEMPTS}):`, error instanceof Error ? error.message : error);
        }
        if (attempt < PROBE_ATTEMPTS) {
          await new Promise<void>((resolve) => setTimeout(resolve, PROBE_RETRY_MS * attempt).unref?.());
        }
      }
    };
    void refreshModels().catch(() => {});

    const sendTurn = async (turn: SendTurnInput) => {
      turn = { ...turn, toolScope: assertToolScopeSupported(DRIVER_KIND, turn.toolScope) };
      if (disposed) throw new Error("This provider was removed. Select an engine and send again.");
      if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");
      const approvalMode: ApprovalMode = turn.approvalMode ?? "ask";
      const turnId = newId();
      const { threadId } = turn;
      const cwd = turn.cwd ?? homedir();
      const workspace = zcodeWorkspaceRef(cwd);
      const mode = zcodePermissionMode(approvalMode);

      const env = childEnv();
      const mcpServers: Record<string, unknown>[] = [];
      const scopedServer = (name: string, server: McpServerSpec): McpServerSpec | null => {
        if (!canUseMcpServer(turn.toolScope, name)) return null;
        if (turn.toolScope === undefined) return server;
        return gateServer({ name, server, threadId, budget: 0, toolScope: turn.toolScope, nodeEnv: {},
          configEnvName: `OMB_GATE_CONFIG_${createHash("sha256").update(name).digest("hex")}` });
      };
      const mount = (name: string, server: McpServerSpec) => {
        const selected = scopedServer(name, server);
        if (selected) mcpServers.push(zcodeMcpServerParam(name, selected));
      };
      if (turn.integrations?.composio) mount("agents-connectors", turn.integrations.composio);
      if (turn.integrations?.agents) mount("agents", turn.integrations.agents);
      if (turn.integrations?.localComputer) mount("computer", turn.integrations.localComputer);
      if (turn.integrations?.browser) mount("browser", turn.integrations.browser);
      if (turn.integrations?.phone) mount("openmausbot_phone", turn.integrations.phone);
      for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) {
        if (!("url" in server)) {
          const reserved = Object.keys(server.env).find(isHarnessOwnedMcpEnvName);
          if (reserved) throw new Error(`Custom MCP server “${name}” cannot set reserved environment variable “${reserved}”`);
        }
        mount(name, server);
      }

      // One session id per conversation; the cursor carries it across turns.
      const cursor = typeof turn.resumeCursor === "string" && turn.resumeCursor.startsWith("sess_")
        ? turn.resumeCursor
        : null;
      // A chosen model is reasserted on every turn: fresh sessions take it
      // in create params, resumed sessions get session/setMode's sibling
      // session/setModel. An unparseable id fails loudly — a turn must never
      // silently run on a different model than the one selected.
      const selection = turn.model && turn.model !== "agent-default" ? zcodeParseModelId(turn.model) : null;
      if (turn.model && turn.model !== "agent-default" && !selection) {
        throw new Error(`"${turn.model}" is not a zcode model selection (expected provider/model with an optional $reasoning level). Pick a model from this engine's list.`);
      }
      // The persona rides the first prompt of a fresh session: the protocol
      // has no developer-instructions slot, so the system prompt travels
      // with the turn text and stays in the session history from then on.
      const promptText = cursor || !turn.system?.trim() ? turn.text : `${turn.system.trim()}\n\n${turn.text}`;
      if (!promptText.trim()) throw new Error("nothing to send: the turn has no text");

      const child = spawnCli(config.cli, ["app-server"], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let abandoned = false;
      let sessionId: string | null = null;
      const state = {
        settled: false,
        lastText: "",
        sawStreamDelta: false,
        nudged: false,
        stopRequested: false,
        usage: undefined as { input: number; output: number; cachedInput?: number } | undefined,
        toolInputs: new Map<string, unknown>(),
        startedTools: new Set<string>(),
      };
      const asks = new Map<string, (behavior: "allow" | "deny" | "answer", message?: string, source?: "user" | "timeout" | "system") => void>();
      let nextId = 1;
      const rpcPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

      const send = (obj: unknown) => {
        try {
          child.stdin.write(JSON.stringify(obj) + "\n");
        } catch {}
        appendNative(threadId, { dir: "out", source: "zcode.app-server", msg: obj });
      };
      const request = (method: string, params: unknown, timeoutMs = 60_000) =>
        new Promise<any>((resolve, reject) => {
          const id = nextId++;
          const timer = setTimeout(() => {
            if (rpcPending.delete(id)) reject(new Error(`zcode ${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          if (typeof timer.unref === "function") timer.unref();
          rpcPending.set(id, {
            resolve: (v) => {
              clearTimeout(timer);
              resolve(v);
            },
            reject: (e) => {
              clearTimeout(timer);
              reject(e);
            },
          });
          send({ id, method, params });
        });

      const settle = async (ok: boolean, stopReason: string | null) => {
        if (state.settled) return;
        state.settled = true;
        for (const finish of Array.from(asks.values())) finish("deny", "OpenMausBot: the turn ended", "system");
        for (const p of rpcPending.values()) p.reject(new Error("turn settled"));
        rpcPending.clear();
        const stopped = await killCliTree(child);
        if (active.get(threadId)?.turnId !== turnId) return;
        active.delete(threadId);
        if (!stopped) emit({ ...base(threadId, turnId), type: "runtime.error", message: "zcode did not shut down after termination was requested" });
        emit({
          ...base(threadId, turnId),
          type: "turn.completed",
          ok,
          stopReason,
          cost: null,
          ...(state.usage ? { usage: state.usage } : {}),
        });
      };

      const stop = async (): Promise<boolean> => {
        state.stopRequested = true;
        if (!state.settled && sessionId && child.exitCode === null && child.signalCode === null) {
          try {
            await request("session/stop", { sessionId }, 3_000);
          } catch {
            // Old CLI without the method, or a wedged server: kill below.
          }
        }
        return killCliTree(child);
      };

      // server→client requests. `interaction/requestPermission` is the
      // approval channel; `interaction/requestUserInput` is the structured
      // ask. Everything else fails closed with -32601 so the CLI's own
      // compatibility fallback applies rather than a guessed answer.
      const handleServerRequest = (msg: any) => {
        const method = String(msg.method ?? "");
        const params = (msg.params ?? {}) as Record<string, unknown>;
        if (method === "interaction/requestPermission") {
          const allowResponse = approvalMode === "full" ? zcodeAllowOption(params) : null;
          if (allowResponse) {
            send({ id: msg.id, result: allowResponse });
            return;
          }
          const requestId = newId();
          const { tool, summary, command } = zcodeRequestSummary(params);
          const timer = setTimeout(() => finish("deny", DENY_TIMEOUT_NOTE, "timeout"), 15 * 60_000);
          timer.unref?.();
          const finish = (behavior: "allow" | "deny" | "answer", message?: string, source: "user" | "timeout" | "system" = "user") => {
            if (!asks.delete(requestId)) return;
            clearTimeout(timer);
            // Echo one of the CLI's own option responses when the decision
            // matches one; a deny without a deny option still answers with
            // the plain decision, which the schema accepts.
            const options = Array.isArray(params.options) ? params.options as Array<{ response?: { decision?: unknown } }> : [];
            const matching = options.find((o) => o && typeof o === "object" && o.response?.decision === (behavior === "allow" ? "allow" : "deny"));
            send({ id: msg.id, result: matching?.response && typeof matching.response === "object"
              ? matching.response as Record<string, unknown>
              : { decision: behavior === "allow" ? "allow" : "deny", ...(message ? { reason: message } : {}) } });
            emit({ ...base(threadId, turnId), type: "request.resolved", requestId, behavior, source });
          };
          asks.set(requestId, finish);
          emit({
            ...base(threadId, turnId),
            type: "request.opened",
            requestId,
            requestType: "permission",
            tool,
            summary,
            ...(command?.cwd ? { command } : {}),
          });
          return;
        }
        if (method === "interaction/requestUserInput") {
          const requestId = newId();
          const prompt = typeof params.prompt === "string" ? params.prompt : "The engine asks for input";
          const choices = Array.isArray(params.choices)
            ? params.choices.filter((c): c is string => typeof c === "string")
            : [];
          const timer = setTimeout(() => finish("deny", undefined, "timeout"), 15 * 60_000);
          timer.unref?.();
          const finish = (behavior: "allow" | "deny" | "answer", message?: string, source: "user" | "timeout" | "system" = "user") => {
            if (!asks.delete(requestId)) return;
            clearTimeout(timer);
            if (behavior === "answer" && source === "user" && typeof message === "string" && message.trim()) {
              send({ id: msg.id, result: { action: "accept", content: { value: message } } });
            } else {
              send({ id: msg.id, result: { action: behavior === "allow" ? "accept" : "cancel" } });
            }
            emit({ ...base(threadId, turnId), type: "request.resolved", requestId, behavior: behavior === "answer" ? "answer" : behavior, source });
          };
          asks.set(requestId, finish);
          emit({
            ...base(threadId, turnId),
            type: "request.opened",
            requestId,
            requestType: "question",
            tool: "ask_user",
            summary: prompt,
            ...(choices.length ? { choices } : {}),
          });
          return;
        }
        send({ id: msg.id, error: { code: -32601, message: `Unsupported server request: ${method}` } });
      };

      // A session/event's discriminator is `params.type`; the member data is
      // `params.payload` (verified on the wire: {"type": "turn.completed",
      // "payload": {"response": ...}}). Switching on payload.type — the
      // schema file's union reads as if the type sat inside the payload —
      // silently misses every completion, which is exactly what the first
      // live run did.
      const handleEvent = (eventParams: any) => {
        const payload = eventParams?.payload;
        if (!payload || typeof payload !== "object") return;
        switch (eventParams.type) {
          case "part.delta": {
            // The model.streaming family carries the same deltas with a kind
            // tag; this driver decodes only that family, so a part.delta
            // here would double the text.
            break;
          }
          case "model.streaming": {
            // The CLI strips a call's input from its `scheduled` update
            // (inputOmitted, inputRef "model_stream") once the model stream
            // has carried it here, so this is the only copy of the command.
            if (payload.kind === "tool_call" && typeof payload.toolCallId === "string" && "input" in payload) {
              state.toolInputs.set(payload.toolCallId, payload.input);
              break;
            }
            const delta = typeof payload.delta === "string" ? payload.delta : "";
            if (!delta) break;
            if (payload.kind === "text_delta") {
              state.sawStreamDelta = true;
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
            } else if (payload.kind === "reasoning_delta") {
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta });
            }
            break;
          }
          case "tool.updated": {
            const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
            const title = typeof payload.toolName === "string" && payload.toolName ? payload.toolName : "tool";
            if (!toolCallId) break;
            if (payload.kind === "scheduled" || payload.kind === "started") {
              // Every call reports both; one chip per call.
              if (state.startedTools.has(toolCallId)) break;
              state.startedTools.add(toolCallId);
              const input = payload.input !== undefined ? payload.input : state.toolInputs.get(toolCallId);
              state.toolInputs.delete(toolCallId);
              emit({
                ...base(threadId, turnId),
                type: "item.started",
                itemType: "tool",
                itemId: toolCallId,
                title,
                summary: commandSummary(input),
                input: toolDetailPreview(input),
              });
            } else if (payload.kind === "error") {
              const message = typeof payload.error?.message === "string" ? payload.error.message : "tool failed";
              emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId: toolCallId, ok: false, output: toolDetailPreview(message) });
            } else if (payload.kind === "result" || payload.kind === "completed") {
              const result = payload.result && typeof payload.result === "object" ? payload.result as Record<string, unknown> : null;
              emit({
                ...base(threadId, turnId),
                type: "item.completed",
                itemType: "tool",
                itemId: toolCallId,
                ok: result?.success !== false,
                output: toolDetailPreview(result?.content ?? result),
              });
            }
            break;
          }
          case "turn.completed": {
            const response = typeof payload.response === "string" ? payload.response : "";
            if (response.trim()) {
              state.lastText = response;
              if (!state.sawStreamDelta) {
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: response });
              }
              state.sawStreamDelta = false;
              emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: response });
            }
            const usage = payload.usage && typeof payload.usage === "object" ? payload.usage as Record<string, unknown> : null;
            if (usage) {
              const input = typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
              const output = typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
              state.usage = {
                input: (state.usage?.input ?? 0) + input,
                output: (state.usage?.output ?? 0) + output,
                ...(typeof usage.cacheReadTokens === "number" || state.usage?.cachedInput !== undefined
                  ? { cachedInput: (state.usage?.cachedInput ?? 0) + (typeof usage.cacheReadTokens === "number" ? usage.cacheReadTokens : 0) }
                  : {}),
              };
            }
            if (payload.resultType === "success" && !state.settled && !state.stopRequested && !abandoned &&
                !state.nudged && sessionId && announcesAction(response)) {
              state.nudged = true;
              // Keep the same native session, mode, model, and MCP grants.
              // Only the continuation's completion closes the harness turn.
              void request("session/send", { sessionId, content: CONTINUATION_NUDGE }).catch((error) => {
                if (state.settled || abandoned || state.stopRequested) return;
                emit({ ...base(threadId, turnId), type: "runtime.error", message: `zcode continuation failed: ${String(error)}` });
                void settle(false, "continuation_failed");
              });
              break;
            }
            void settle(true, payload.resultType === "cancelled" ? "interrupted" : null);
            break;
          }
          case "turn.failed": {
            const error = payload.error && typeof payload.error === "object" ? payload.error as Record<string, unknown> : null;
            const message = typeof error?.message === "string" && error.message ? error.message : "zcode turn failed";
            emit({ ...base(threadId, turnId), type: "runtime.error", message });
            void settle(false, classifyError({ text: message }).reason === "provider_safety" ? "provider_safety" : "failed");
            break;
          }
        }
      };

      let buf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (abandoned || state.settled) return;
        buf += chunk;
        let nl;
        while (!state.settled && (nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          appendNative(threadId, { dir: "in", source: "zcode.app-server", msg });
          if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const pend = rpcPending.get(msg.id);
            if (pend) {
              rpcPending.delete(msg.id);
              if (msg.error) pend.reject(new Error(String(msg.error.message ?? "zcode rpc error")));
              else pend.resolve(msg.result);
            }
          } else if (msg.id !== undefined && msg.method) {
            handleServerRequest(msg);
          } else if (msg.method === "session/event") {
            handleEvent(msg.params);
          }
        }
      });

      let stderr = "";
      child.stderr.on("data", (c) => {
        stderr += c;
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });
      child.on("error", (e) => {
        if (abandoned) return;
        emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
        void settle(false, "spawn_error");
      });
      child.on("close", (code, signal) => {
        if (abandoned || state.settled) return;
        emit({
          ...base(threadId, turnId),
          type: "runtime.error",
          message: `zcode exited ${code}${signal ? ` (signal ${signal})` : ""} before turn.completed${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ""}`,
        });
        void settle(false, "exit_before_result");
      });

      active.set(threadId, { stop, turnId, asks });
      emit({ ...base(threadId, turnId), type: "turn.started" });

      try {
        // Resume into the exact native session first: a refusal here fails
        // the turn (strictResume) instead of silently starting a blank one.
        if (cursor) {
          const resumed = await request("session/resume", { sessionId: cursor, workspace, mcpServers: mcpServers.length ? mcpServers : undefined });
          sessionId = resumed?.session?.sessionId ?? cursor;
        } else {
          const created = await request("session/create", {
            workspace,
            mode,
            titleGenerationEnabled: false,
            mcpServers: mcpServers.length ? mcpServers : undefined,
          });
          sessionId = created?.session?.sessionId;
        }
        if (!sessionId) throw new Error("zcode did not return a session id");
        // Reassert mode AND model on every turn, fresh or resumed: a
        // session keeps its previous settings, and a stale looser mode can
        // never survive the switch. The model rides session/setModel, not
        // create params — create resolves the selection without its
        // reasoning options (verified live: a create with a reasoning-level
        // selection fails the turn with "Reasoning level is required"),
        // while setModel honours them.
        await request("session/setMode", { sessionId, mode });
        if (selection) await request("session/setModel", { sessionId, model: selection });
        if (!sessionId) throw new Error("zcode did not return a session id");
        await request("session/subscribe", { sessionId, deliveryKind: "desktop-continuous", includeSnapshot: false });
        emit({ ...base(threadId, turnId), type: "session.started", sessionId, model: null });
        await request("session/send", { sessionId, content: promptText });
      } catch (e) {
        if (!state.settled && !abandoned) {
          const message = e instanceof Error ? e.message : String(e);
          const needsAuth = /(?:\b401\b|unauthorized|not signed in|login required|authentication)/i.test(message);
          emit({ ...base(threadId, turnId), type: "runtime.error", message, ...(needsAuth ? { setup: true } : {}) });
          await settle(false, needsAuth ? "auth_required" : "setup_failed");
        }
      }
      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const env = childEnv();
      const version = await new Promise<string | null>((resolve) => {
        execCli(config.cli, ["version"], { timeout: 8000, env }, (err, stdout) =>
          resolve(err ? null : stdout.trim()),
        );
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      const auth = authStatus(env);
      return {
        state: "available",
        version,
        authenticated: auth.authenticated,
        ...(auth.authenticated ? {} : { reason: auth.hint }),
        billing: "subscription",
      };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return models;
      },
      refreshModels,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: {
          sessionModelSwitch: "in-session",
          computerMcp: true,
          localComputerMcp: true,
          composioMcp: true,
          agentsMcp: true,
          customMcp: true,
          phoneMcp: true,
          browserMcp: true,
          strictResume: true,
        },
        sendTurn,
        interruptTurn: async (threadId) => {
          await active.get(threadId)?.stop();
        },
        respondToRequest: async (threadId, requestId, decision) => {
          const turn = active.get(threadId);
          const finish = turn?.asks.get(requestId);
          if (!finish) return "unavailable";
          finish(decision.behavior, decision.message, "user");
          return decision.behavior === "allow" ? "allowed-once" : decision.behavior === "answer" ? "answered" : "rejected";
        },
        steer: async (): Promise<SteerOutcome> => "refused",
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          await Promise.all([...active.values()].map(({ stop }) => stop()));
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        disposed = true;
        if (probeChild) {
          const child = probeChild;
          probeChild = null;
          void killCliTree(child);
        }
        await Promise.all([...active.values()].map(({ stop }) => stop()));
        listeners.clear();
      },
    };
  },
};

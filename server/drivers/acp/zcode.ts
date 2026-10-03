// ZCode (z.ai GLM harness) support — the local `zcode-acp` adapter over ACP
// stdio. The generic protocol runtime lives in acp/core.ts; this file is only
// the per-harness quirks.
//
// zcode itself does not speak ACP; the adapter (github.com/Clauber/zcode-acp,
// also usable via ZCODE_ACP_ZCODE_BIN) wraps one `zcode -p <text> --json
// [--resume sess_*]` process per turn and translates the result back. The
// conversation continues across turns through zcode's own persisted sess_* ids
// (loadSession stays false — resume is internal to the adapter).
//
// Headless zcode auto-denies tool use in every mode except yolo ("no
// permission client connected"), so the adapter advertises exactly one mode
// and never asks the client for permissions. Approval levels other than Full
// access are therefore cosmetic on this engine: the CLI has no ask/edits mode
// to map them onto.
//
// Models: zcode takes no --model flag; its model comes from the personal
// provider config (desktop ~/.zcode/v2/provider_config.json carries every
// provider the app offers). resolveModels lists that catalog — prefixed
// `<provider>::<model>` — and configureSession pins the pick per turn via
// the adapter's session/set_model, which rotates a copy of the config. The
// bare "zcode-default" keeps the config's own default.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { userHome } from "../../env-path.ts";
import type { ModelCatalog } from "../../contracts.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

// Same probes the adapter itself runs in authenticate: the GLM headless
// wrapper's provider config is the reliable "already signed in" marker on
// machines set up like ours; stock installs keep credentials under ~/.zcode/cli.
export function zcodeAuthProbe(env: Record<string, string | undefined>): boolean {
  if (env.ZCODE_ACP_SKIP_AUTH_CHECK === "1") return true;
  const home = userHome(env);
  const candidates = [
    env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,
    join(home, ".zcode", "headless", "provider_config.json"),
  ].filter((p): p is string => Boolean(p));
  return candidates.some((p) => existsSync(p)) || existsSync(join(home, ".zcode", "cli"));
}

// Composite model id `<providerId>::<modelId>` — provider ids may contain
// slashes (9router rows like cc/claude-opus-5), so "::" is the separator.
// Must stay in sync with the adapter's ids.
export const ZCODE_DEFAULT_MODEL_ID = "zcode-default";

interface ZcodeProviderConfig {
  providerOrder?: unknown;
  providerConfigRules?: { providerRules?: Array<{
    providerId?: unknown;
    config?: { modelOrder?: unknown; personalModelIds?: unknown };
  }> };
}

/** The adapter's provider-config search order: desktop first (every provider
 *  the app offers), the wrapper's headless config as the last resort. */
function providerConfigCandidates(env: Record<string, string | undefined>): string[] {
  const home = userHome(env);
  return [
    env.ZCODE_ACP_PROVIDER_CONFIG,
    join(home, ".zcode", "v2", "provider_config.json"),
    env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,
    join(home, ".zcode", "headless", "provider_config.json"),
  ].filter((p): p is string => Boolean(p));
}

function readProviderCatalog(env: Record<string, string | undefined>): Array<{ providerId: string; modelId: string }> {
  for (const path of providerConfigCandidates(env)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const config = ((parsed as { config?: ZcodeProviderConfig })?.config ?? parsed) as ZcodeProviderConfig;
    if (!config || typeof config !== "object") continue;
    const rules = Array.isArray(config.providerConfigRules?.providerRules) ? config.providerConfigRules.providerRules : [];
    const byId = new Map<string, string[]>();
    for (const rule of rules) {
      if (typeof rule?.providerId !== "string" || !rule.providerId) continue;
      const inner = rule.config && typeof rule.config === "object" ? rule.config : {};
      const models = Array.isArray(inner.modelOrder) && inner.modelOrder.length
        ? inner.modelOrder
        : (Array.isArray(inner.personalModelIds) ? inner.personalModelIds : []);
      const clean = models.filter((m): m is string => typeof m === "string" && m.length > 0);
      if (clean.length) byId.set(rule.providerId, clean);
    }
    if (!byId.size) continue;
    const order = [
      ...(Array.isArray(config.providerOrder) ? config.providerOrder : []),
      ...byId.keys(),
    ].filter((id): id is string => typeof id === "string" && byId.has(id))
      .filter((id, i, all) => all.indexOf(id) === i);
    const entries: Array<{ providerId: string; modelId: string }> = [];
    for (const providerId of order) {
      for (const modelId of byId.get(providerId)!) entries.push({ providerId, modelId });
    }
    return entries;
  }
  return [];
}

/** The picker catalog: every model the provider config offers, plus the
 *  passthrough default. `custom: true` is not cosmetic — the model picker
 *  renders a custom-only agent's custom pane exclusively, and that pane
 *  lists only options carrying the flag. */
export function zcodeModelCatalog(env: Record<string, string | undefined>): ModelCatalog {
  const options = [
    { id: ZCODE_DEFAULT_MODEL_ID, label: "ZCode default (provider config)", custom: true as const },
    ...readProviderCatalog(env).map(({ providerId, modelId }) => ({
      id: `${providerId}::${modelId}`,
      label: `${modelId} · ${providerId}`,
      custom: true as const,
    })),
  ];
  return { default: ZCODE_DEFAULT_MODEL_ID, options };
}

// Fallback when no provider config parses anywhere: one passthrough id, the
// model is whatever zcode's config selected.
const MODELS: ModelCatalog = {
  default: ZCODE_DEFAULT_MODEL_ID,
  options: [{ id: ZCODE_DEFAULT_MODEL_ID, label: "ZCode default (provider config)" }],
};

async function applySetting(
  request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>,
  method: string,
  params: Record<string, unknown>,
  what: string,
) {
  try {
    await request(method, params);
  } catch (e) {
    throw new Error(`ZCode rejected ${what} via ${method}: ${(e as Error).message}. ` +
      "Check that the zcode-acp adapter is current (0.3.0+ supports session/set_model) and that the model is still in the provider config.");
  }
}

const support: AcpSupport = {
  driverKind: "zcodeAgent",
  displayName: "ZCode",
  access: "custom",
  models: MODELS,
  resolveModels: (env) => zcodeModelCatalog(env),
  defaultCli: "zcode-acp",
  nativeSource: "zcode.acp",
  loginNote: "zcode-acp adapter is not installed — put it on PATH or set this instance's CLI",
  install: {
    docsUrl: "https://github.com/Clauber/zcode-acp",
    signInCommand: "zcode login",
  },
  // The adapter takes no argv; the zcode binary and its knobs ride env
  // (ZCODE_ACP_ZCODE_BIN, ZCODE_ACP_MODES, ZCODE_ACP_SKIP_AUTH_CHECK).
  spawnArgs: () => [],
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: (env) => zcodeAuthProbe(env),
  async configureSession({ request, sessionId, turn }) {
    if (!turn.model || turn.model === ZCODE_DEFAULT_MODEL_ID) return;
    await applySetting(request, "session/set_model", { sessionId, modelId: turn.model }, `model "${turn.model}"`);
  },
  // House convention for ACP harnesses: the persona rides in the prompt text.
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const ZCodeAgentDriver = createAcpDriver(support);

import type { ModelCatalog } from "../../contracts.ts";

const FALLBACK: ModelCatalog = { default: "agent-default", options: [{ id: "agent-default", label: "Agent default" }] };

function field(input: unknown, key: string): unknown {
  return input !== null && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
}

function nonEmptyString(input: unknown): string | undefined {
  return typeof input === "string" && input.trim().length > 0 ? input : undefined;
}

function levelValues(levels: unknown, key?: string): string[] {
  return (Array.isArray(levels) ? levels : []).flatMap((level) => {
    const value = nonEmptyString(key === undefined ? level : field(level, key));
    return value === undefined ? [] : [value];
  });
}

/** The level a model starts at: "high" when it offers one, else the level the server reports, else the last. */
export function defaultZcodeReasoningLevel(levels: readonly string[], reported?: string): string | null {
  if (levels.includes("high")) return "high";
  return reported !== undefined && levels.includes(reported) ? reported : (levels.at(-1) ?? null);
}

/** Reads the reasoning ladder from a `session/setModel` result's `thoughtLevel`. */
export function parseZcodeThoughtLevels(thoughtLevel: unknown): { levels: string[]; defaultLevel: string | null } {
  const levels = levelValues(field(thoughtLevel, "available"), "value");
  return { levels, defaultLevel: defaultZcodeReasoningLevel(levels, nonEmptyString(field(thoughtLevel, "defaultLevel"))) };
}

/** Builds the picker catalog from the ZCode server's `modelSelectionService.getView()`. Ids are `providerId/modelId$level`, the format `zcodeTurnModel` reads back. */
export function zcodeCatalogFromServerView(view: unknown): ModelCatalog {
  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  const preferred = field(view, "preferredSelection");
  const preferredProvider = nonEmptyString(field(preferred, "providerId"));
  const preferredModel = nonEmptyString(field(preferred, "modelId"));
  let defaultId: string | undefined;
  for (const provider of Array.isArray(field(view, "providers")) ? (field(view, "providers") as unknown[]) : []) {
    const providerId = nonEmptyString(field(provider, "providerId"));
    if (providerId === undefined) continue;
    const providerName = nonEmptyString(field(provider, "providerName")) ?? providerId;
    for (const model of Array.isArray(field(provider, "models")) ? (field(provider, "models") as unknown[]) : []) {
      const modelId = nonEmptyString(field(model, "modelId"));
      const config = field(model, "config");
      if (modelId === undefined || field(config, "enabled") === false) continue;
      const levels = levelValues(field(field(field(config, "optionSpecs"), "reasoningLevel"), "values"));
      const level = defaultZcodeReasoningLevel(levels);
      const id = `${providerId}/${modelId}${level === null ? "" : `$${level}`}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const contextWindow = field(field(config, "properties"), "contextWindow");
      options.push({
        id,
        label: modelId,
        provider: providerName,
        ...(typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
        ...(levels.length > 0 ? { variants: levels.map((value) => ({ id: value, label: value })) } : {}),
      });
      if (defaultId === undefined && providerId === preferredProvider && modelId === preferredModel) defaultId = id;
    }
  }
  if (options.length === 0) return FALLBACK;
  return { default: defaultId ?? options[0].id, options };
}

/** Splits a catalog id into a turn's model selection. The provider ends at the FIRST slash because personal model ids carry their own slashes; an explicit variant overrides the id's level. Null for a bare or malformed id. */
export function zcodeTurnModel(id: string, variant?: string): { providerId: string; modelId: string; options?: { reasoningLevel: string } } | null {
  const dollar = id.indexOf("$");
  const base = dollar === -1 ? id : id.slice(0, dollar);
  const idLevel = dollar === -1 ? undefined : id.slice(dollar + 1);
  if (dollar !== -1 && (!idLevel || idLevel.includes("/") || idLevel.includes("$"))) return null;
  const slash = base.indexOf("/");
  if (slash <= 0 || slash === base.length - 1) return null;
  const level = nonEmptyString(variant)?.trim() ?? idLevel;
  return {
    providerId: base.slice(0, slash),
    modelId: base.slice(slash + 1),
    ...(level ? { options: { reasoningLevel: level } } : {}),
  };
}

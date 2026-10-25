import { describe, expect, it } from "vitest";
import { zcodeModelId, zcodeParseModelId } from "../zcode.ts";
import { defaultZcodeReasoningLevel, parseZcodeThoughtLevels, zcodeCatalogFromServerView, zcodeTurnModel } from "./models.ts";

const ladder = (...values: string[]) => ({ optionSpecs: { reasoningLevel: { values } } });

const VIEW = {
  revision: 3,
  providers: [
    {
      providerId: "account:zai-start-plan",
      providerName: "Start Plan",
      models: [
        { modelId: "GLM-5.3-Flash", config: { ...ladder("low", "high", "max") } },
        { modelId: "GLM-5.3", config: { enabled: false, ...ladder("low", "high") } },
      ],
    },
    {
      providerId: "deepseek",
      models: [
        { modelId: "deepseek-chat", config: { properties: { contextWindow: 64000 }, ...ladder("disabled", "enabled") } },
        { modelId: "plain", config: {} },
        { modelId: "plain", config: {} },
        { modelId: "kiro/claude-opus-5", config: {} },
      ],
    },
  ],
  preferredSelection: { providerId: "deepseek", modelId: "deepseek-chat", options: { reasoningLevel: "enabled" } },
};

describe("defaultZcodeReasoningLevel", () => {
  it("prefers high, then the reported level, then the last level", () => {
    expect(defaultZcodeReasoningLevel(["low", "high", "max"], "max")).toBe("high");
    expect(defaultZcodeReasoningLevel(["low", "max"], "low")).toBe("low");
    expect(defaultZcodeReasoningLevel(["low", "max"], "nope")).toBe("max");
    expect(defaultZcodeReasoningLevel(["disabled", "enabled"])).toBe("enabled");
    expect(defaultZcodeReasoningLevel([])).toBeNull();
  });
});

describe("parseZcodeThoughtLevels", () => {
  it("reads the ladder and applies the default rule", () => {
    const available = ["low", "high", "max"].map((value) => ({ label: value, value }));
    expect(parseZcodeThoughtLevels({ available, defaultLevel: "max" })).toEqual({ levels: ["low", "high", "max"], defaultLevel: "high" });
    expect(parseZcodeThoughtLevels({ available: [{ value: "low" }, { value: "max" }], defaultLevel: "low" }).defaultLevel).toBe("low");
    expect(parseZcodeThoughtLevels(undefined)).toEqual({ levels: [], defaultLevel: null });
  });
});

describe("zcodeCatalogFromServerView", () => {
  it("builds rows with baked default levels, variants, provider names and context windows", () => {
    const catalog = zcodeCatalogFromServerView(VIEW);
    expect(catalog.options).toEqual([
      {
        id: "account:zai-start-plan/GLM-5.3-Flash$high",
        label: "GLM-5.3-Flash",
        provider: "Start Plan",
        variants: [{ id: "low", label: "low" }, { id: "high", label: "high" }, { id: "max", label: "max" }],
      },
      {
        id: "deepseek/deepseek-chat$enabled",
        label: "deepseek-chat",
        provider: "deepseek",
        contextWindow: 64000,
        variants: [{ id: "disabled", label: "disabled" }, { id: "enabled", label: "enabled" }],
      },
      { id: "deepseek/plain", label: "plain", provider: "deepseek" },
      { id: "deepseek/kiro/claude-opus-5", label: "kiro/claude-opus-5", provider: "deepseek" },
    ]);
    expect(catalog.default).toBe("deepseek/deepseek-chat$enabled");
  });

  it("defaults to the first row without a matching selection and falls back on an empty view", () => {
    const { preferredSelection: _unused, ...withoutSelection } = VIEW;
    expect(zcodeCatalogFromServerView(withoutSelection).default).toBe("account:zai-start-plan/GLM-5.3-Flash$high");
    const missing = { ...VIEW, preferredSelection: { providerId: "gone", modelId: "gone" } };
    expect(zcodeCatalogFromServerView(missing).default).toBe("account:zai-start-plan/GLM-5.3-Flash$high");
    const fallback = { default: "agent-default", options: [{ id: "agent-default", label: "Agent default" }] };
    expect(zcodeCatalogFromServerView(undefined)).toEqual(fallback);
    expect(zcodeCatalogFromServerView({ providers: [] })).toEqual(fallback);
  });

  it("produces ids that zcodeTurnModel and the existing parser read back identically", () => {
    for (const row of zcodeCatalogFromServerView(VIEW).options) {
      expect(zcodeTurnModel(row.id)).toEqual(zcodeParseModelId(row.id));
      expect(zcodeTurnModel(row.id)).not.toBeNull();
    }
    expect(zcodeModelId({ providerId: "p", modelId: "m/x" }, "high")).toBe("p/m/x$high");
  });
});

describe("zcodeTurnModel", () => {
  it("ends the provider at the first slash and reads the level after $", () => {
    expect(zcodeTurnModel("zai/glm-5")).toEqual({ providerId: "zai", modelId: "glm-5" });
    expect(zcodeTurnModel("prov/kiro/claude-opus-5$max")).toEqual({ providerId: "prov", modelId: "kiro/claude-opus-5", options: { reasoningLevel: "max" } });
  });

  it("lets an explicit variant win over the id's level", () => {
    expect(zcodeTurnModel("zai/glm-5$high", "low")).toEqual({ providerId: "zai", modelId: "glm-5", options: { reasoningLevel: "low" } });
    expect(zcodeTurnModel("zai/glm-5", "low")?.options).toEqual({ reasoningLevel: "low" });
    expect(zcodeTurnModel("zai/glm-5$high", "  ")?.options).toEqual({ reasoningLevel: "high" });
  });

  it("returns null for bare or malformed ids", () => {
    for (const id of ["glm-5", "/glm-5", "zai/", "zai/glm$", "zai/glm$a/b", "zai/glm$a$b", "$high", "agent-default", ""]) {
      expect(zcodeTurnModel(id), id).toBeNull();
    }
  });
});

import { describe, expect, it } from "vitest";

import { filterCustomModels, groupModelsByProvider, hasMultipleProviders, partitionCustomModels, suggestedModels } from "./custom-models";

const rows = [
  { id: "omlx::gemma-4-31b-it-bf16", label: "gemma-4-31b-it-bf16 (oMLX)", loaded: true },
  { id: "omlx::GLM-5.2-fp8", label: "GLM-5.2-fp8 (oMLX)" },
  { id: "ollama::llama3.2:latest", label: "llama3.2:latest (Ollama)" },
];

describe("filterCustomModels", () => {
  it("matches the visible label or the encoded host id", () => {
    expect(filterCustomModels(rows, "gemma").map((row) => row.id)).toEqual(["omlx::gemma-4-31b-it-bf16"]);
    expect(filterCustomModels(rows, "OLLAMA").map((row) => row.id)).toEqual(["ollama::llama3.2:latest"]);
    expect(filterCustomModels(rows, "omlx").map((row) => row.id)).toEqual([
      "omlx::gemma-4-31b-it-bf16",
      "omlx::GLM-5.2-fp8",
    ]);
  });

  it("treats blank search as no filter", () => {
    expect(filterCustomModels(rows, "  ")).toEqual(rows);
  });
});

describe("partitionCustomModels", () => {
  it("pins loaded models first and keeps relative order", () => {
    expect(partitionCustomModels(rows)).toEqual({
      pinned: [rows[0]],
      rest: [rows[1], rows[2]],
    });
  });

  it("skips the divider groups when nothing is loaded", () => {
    expect(partitionCustomModels(rows.filter((row) => !row.loaded))).toEqual({
      pinned: [],
      rest: [rows[1], rows[2]],
    });
  });
});

describe("suggestedModels", () => {
  it("pins the active and default models before filling from catalog order", () => {
    const options = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id }));
    expect(suggestedModels(options, "b", "f", 4).map((option) => option.id)).toEqual(["f", "b", "a", "c"]);
  });

  it("does not duplicate a current default", () => {
    const options = ["a", "b", "c"].map((id) => ({ id }));
    expect(suggestedModels(options, "b", "b", 3).map((option) => option.id)).toEqual(["b", "a", "c"]);
  });
});

describe("groupModelsByProvider", () => {
  it("chunks consecutive rows of one provider, keeping catalog order", () => {
    const rows = [
      { id: "a1", provider: "AvelloCC" },
      { id: "a2", provider: "AvelloCC" },
      { id: "b1", provider: "9Router" },
      { id: "b2", provider: "9Router" },
      { id: "b3", provider: "9Router" },
    ];
    expect(groupModelsByProvider(rows)).toEqual([
      { provider: "AvelloCC", options: [rows[0], rows[1]] },
      { provider: "9Router", options: [rows[2], rows[3], rows[4]] },
    ]);
  });

  it("reunites rows the suggested list scattered, so a provider gets one section", () => {
    const rows = [
      { id: "b1", provider: "9Router" },
      { id: "default" },
      { id: "b2", provider: "9Router" },
      { id: "a1", provider: "AvelloCC" },
    ];
    expect(groupModelsByProvider(rows)).toEqual([
      { provider: "9Router", options: [rows[0], rows[2]] },
      { options: [rows[1]] },
      { provider: "AvelloCC", options: [rows[3]] },
    ]);
  });

  it("gives rows without a provider — a passthrough default — a headerless group", () => {
    const rows = [
      { id: "default" },
      { id: "m1", provider: "DeepSeek" },
    ];
    expect(groupModelsByProvider(rows)).toEqual([
      { options: [rows[0]] },
      { provider: "DeepSeek", options: [rows[1]] },
    ]);
  });

  it("returns nothing to chunk for an empty list", () => {
    expect(groupModelsByProvider([])).toEqual([]);
  });
});

describe("hasMultipleProviders", () => {
  const row = (id: string, provider?: string): { id: string; provider?: string } => ({ id, provider });
  it("is true only when the list spans more than one named provider", () => {
    expect(hasMultipleProviders([
      row("default"),
      row("m1", "DeepSeek"),
      row("m2", "9Router"),
    ])).toBe(true);
    // one provider plus the headerless default keeps the per-row badge
    expect(hasMultipleProviders([
      row("default"),
      row("m1", "DeepSeek"),
    ])).toBe(false);
    expect(hasMultipleProviders([
      row("m1", "DeepSeek"),
      row("m2", "DeepSeek"),
    ])).toBe(false);
    expect(hasMultipleProviders([row("m1")])).toBe(false);
    expect(hasMultipleProviders([])).toBe(false);
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BUILTIN_MCP_CATALOG } from "./mcp-catalog-data.ts";
import {
  createEnvLookup,
  installCatalogEntry,
  listCatalog,
  loadUserCatalog,
  mergeCatalogs,
  parseRegistry,
  resolveCatalogSecrets,
  type CatalogEntry,
} from "./mcp-catalog.ts";
import { listMcpServers } from "./mcp-registry.ts";

// Placeholder values only: these tests prove secrets are dropped and routed,
// so every value is an obvious marker string, never a credential.
const REGISTRY = {
  mcpServers: {
    gog: {
      type: "http",
      url: "http://gateway.example.test:4000/mcp",
      headers: { "x-litellm-api-key": "SECRET-MARKER-GOG", "x-mcp-servers": "gog" },
    },
    notes: { command: "/usr/bin/notes-mcp", args: ["--root", "/data"], env: { NOTES_TOKEN: "SECRET-MARKER-NOTES", LANGUAGE: "en" } },
    leaky: { command: "/usr/bin/leaky", args: ["--token=SECRET-MARKER-ARG"] },
    "Bad Name": { command: "x" },
    shell: { enabled: true },
  },
};
const META = { gog: { label: "Gmail & Calendar", description: "Mail and calendar via the gog gateway." } };

const lookupNone = () => undefined;

describe("registry parsing", () => {
  const parsed = parseRegistry(REGISTRY, { meta: META, envKeyHints: { "gog/x-litellm-api-key": "GOG_GATEWAY_KEY" } });

  it("turns registry entries into catalog entries and reports what it skipped", () => {
    expect(parsed.entries.map((entry) => entry.name)).toEqual(["gog", "notes"]);
    expect(parsed.skipped.map((skip) => skip.name).sort()).toEqual(["Bad Name", "leaky", "shell"]);
    expect(parsed.entries[0]).toMatchObject({
      name: "gog", label: "Gmail & Calendar", transport: "http",
      url: "http://gateway.example.test:4000/mcp",
      headers: { "x-mcp-servers": "gog" },
      secrets: [{ target: "header", name: "x-litellm-api-key", envKey: "GOG_GATEWAY_KEY" }],
    });
    expect(parsed.entries[1]).toMatchObject({ transport: "stdio", env: { LANGUAGE: "en" }, secrets: [{ target: "env", name: "NOTES_TOKEN" }] });
  });

  it("never carries a secret value into the catalog", () => {
    expect(JSON.stringify(parsed)).not.toContain("SECRET-MARKER");
  });

  it("refuses a missing registry", () => {
    expect(parseRegistry(null).entries).toEqual([]);
    expect(parseRegistry({ mcpServers: [] }).skipped[0]?.reason).toMatch(/mcpServers/);
  });
});

describe("the shipped catalog", () => {
  it("covers the registry's connectors, including the three gog accounts", () => {
    const names = BUILTIN_MCP_CATALOG.map((entry) => entry.name);
    for (const name of ["gog", "gog-clauber93", "gog-cklauber", "grafana", "slack-gsd", "agent-dispatch", "filesystem"]) {
      expect(names).toContain(name);
    }
    expect(BUILTIN_MCP_CATALOG.find((entry) => entry.name === "gog")).toMatchObject({
      transport: "http", url: "http://10.69.42.110:4000/mcp", headers: { "x-mcp-servers": "gog" },
    });
  });

  it("holds only secret names, never a credential-shaped value", () => {
    const text = JSON.stringify(BUILTIN_MCP_CATALOG);
    expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    expect(text).not.toMatch(/Bearer\s+\S/i);
    for (const entry of BUILTIN_MCP_CATALOG) {
      for (const secret of entry.secrets) expect(secret.name.length).toBeGreaterThan(0);
      for (const value of Object.values({ ...entry.headers, ...entry.env })) expect(value).not.toMatch(/^sk-/);
    }
  });

  it("only installs names the registry will accept", () => {
    for (const entry of BUILTIN_MCP_CATALOG) {
      const result = installCatalogEntry({}, entry, { provided: Object.fromEntries(entry.secrets.map((s) => [s.name, "placeholder"])), lookup: lookupNone });
      expect(result.ok, entry.name).toBe(true);
    }
  });
});

describe("secret resolution", () => {
  const entry: CatalogEntry = {
    name: "gog", label: "gog", description: "", transport: "http", url: "http://gateway.example.test/mcp",
    headers: { "x-mcp-servers": "gog" }, secrets: [{ target: "header", name: "x-litellm-api-key", envKey: "GOG_GATEWAY_KEY" }],
  };

  it("reads the named variable, and lets a one-time value win", () => {
    const lookup = (key: string) => (key === "GOG_GATEWAY_KEY" ? "from-env" : undefined);
    expect(resolveCatalogSecrets(entry, undefined, lookup)).toEqual({ ok: true, values: { "x-litellm-api-key": "from-env" } });
    expect(resolveCatalogSecrets(entry, { "x-litellm-api-key": "typed" }, lookup)).toEqual({ ok: true, values: { "x-litellm-api-key": "typed" } });
  });

  it("names what is missing instead of storing an empty header", () => {
    expect(resolveCatalogSecrets(entry, undefined, lookupNone)).toEqual({ ok: false, missing: ["x-litellm-api-key"] });
  });

  it("looks a key up in the environment first, then in env files", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-catalog-env-"));
    try {
      const file = join(dir, ".env");
      writeFileSync(file, "OTHER=1\nFILE_ONLY=\"quoted-value\"\nBOTH=file\n");
      const lookup = createEnvLookup([join(dir, "missing.env"), file], { BOTH: "env" });
      expect(lookup("BOTH")).toBe("env");
      expect(lookup("FILE_ONLY")).toBe("quoted-value");
      expect(lookup("ABSENT")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installing a catalog entry", () => {
  const entry: CatalogEntry = {
    name: "gog", label: "gog", description: "", transport: "http", url: "http://gateway.example.test/mcp",
    headers: { "x-mcp-servers": "gog" }, secrets: [{ target: "header", name: "x-litellm-api-key", envKey: "GOG_GATEWAY_KEY" }],
  };
  const lookup = (key: string) => (key === "GOG_GATEWAY_KEY" ? "placeholder-key" : undefined);

  it("writes one ordinary enabled mcpServers entry", () => {
    const result = installCatalogEntry({ other: { command: "x" } }, entry, { lookup });
    expect(result).toMatchObject({ ok: true, alreadyStored: false });
    if (!result.ok) throw new Error("unreachable");
    expect(result.next).toEqual({
      other: { command: "x" },
      gog: {
        type: "http", url: "http://gateway.example.test/mcp",
        headers: { "x-mcp-servers": "gog", "x-litellm-api-key": "placeholder-key" }, enabled: true,
      },
    });
    expect(listMcpServers(result.next).find((server) => server.name === "gog")).toMatchObject({
      enabled: true, headerKeys: ["x-litellm-api-key", "x-mcp-servers"],
    });
    expect(JSON.stringify(listMcpServers(result.next))).not.toContain("placeholder-key");
  });

  it("asks for the missing secret and writes nothing", () => {
    expect(installCatalogEntry({}, entry, { lookup: lookupNone })).toMatchObject({ ok: false, status: 422, missing: ["x-litellm-api-key"] });
  });

  it("leaves an existing entry untouched", () => {
    const current = { gog: { type: "http", url: "http://elsewhere.example.test/mcp", headers: { "x-litellm-api-key": "own" }, enabled: false } };
    const result = installCatalogEntry(current, entry, { lookup });
    expect(result).toMatchObject({ ok: true, alreadyStored: true });
    if (result.ok) expect(result.next).toBe(current);
  });

  it("stops at the server limit", () => {
    const full = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`s${i}`, { command: "x" }]));
    expect(installCatalogEntry(full, entry, { lookup })).toMatchObject({ ok: false, status: 400 });
  });
});

describe("catalog listing", () => {
  const entries: CatalogEntry[] = [
    { name: "gog", label: "gog", description: "", transport: "http", url: "http://gateway.example.test/mcp", secrets: [{ target: "header", name: "x-litellm-api-key", envKey: "GOG_GATEWAY_KEY" }] },
    { name: "files", label: "files", description: "", transport: "stdio", command: "/usr/bin/files", args: [], secrets: [] },
  ];

  it("marks installed and available entries without exposing values", () => {
    const stored = { files: { command: "/usr/bin/files", enabled: false } };
    const listing = listCatalog(entries, stored, (key) => (key === "GOG_GATEWAY_KEY" ? "placeholder-key" : undefined));
    expect(listing).toEqual([
      expect.objectContaining({ name: "gog", installed: false, enabled: false, secrets: [{ name: "x-litellm-api-key", envKey: "GOG_GATEWAY_KEY", available: true }] }),
      expect.objectContaining({ name: "files", installed: true, enabled: false, target: "/usr/bin/files" }),
    ]);
    expect(JSON.stringify(listing)).not.toContain("placeholder-key");
  });
});

describe("a catalog the person keeps in the data folder", () => {
  const write = (body: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "omb-user-catalog-"));
    const file = join(dir, "mcp-catalog.json");
    writeFileSync(file, JSON.stringify(body));
    return { dir, file };
  };

  it("adds entries, skips malformed ones and any carrying a literal credential", () => {
    const { dir, file } = write({ entries: [
      { name: "mine", transport: "http", url: "http://127.0.0.1:1/mcp", headers: { "x-mcp-servers": "mine" }, secrets: [{ target: "header", name: "x-api-key", envKey: "MINE_KEY" }] },
      { name: "pasted", transport: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer SECRET-MARKER" } },
      { name: "Bad Name", transport: "http", url: "http://127.0.0.1:1/mcp" },
      { name: "no-target", transport: "stdio" },
      { name: "extra-key", transport: "http", url: "http://127.0.0.1:1/mcp", surprise: true },
    ] });
    try {
      const entries = loadUserCatalog(file);
      expect(entries.map((entry) => entry.name)).toEqual(["mine"]);
      expect(entries[0]).toMatchObject({ label: "mine", secrets: [{ target: "header", name: "x-api-key", envKey: "MINE_KEY" }] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is empty when the file is absent or unreadable, and replaces a built-in by name", () => {
    expect(loadUserCatalog(join(tmpdir(), "omb-no-such-catalog.json"))).toEqual([]);
    const { dir, file } = write({ not: "a catalog" });
    try {
      expect(loadUserCatalog(file)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const builtin: CatalogEntry[] = [{ name: "a", label: "A", description: "", transport: "stdio", command: "a", secrets: [] }];
    const merged = mergeCatalogs(builtin, [{ name: "a", label: "Mine", description: "", transport: "stdio", command: "b", secrets: [] }, { name: "b", label: "B", description: "", transport: "stdio", command: "b", secrets: [] }]);
    expect(merged.map((entry) => [entry.name, entry.label])).toEqual([["a", "Mine"], ["b", "B"]]);
  });
});

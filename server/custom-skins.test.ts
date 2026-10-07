import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CustomSkinManager } from "./custom-skins.ts";
import type { CustomSkinManagerEvent } from "./custom-skins.ts";

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-skins-"));
  dirs.push(dir);
  return join(dir, "custom-skins.json");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const AMBER = { name: "Ember", mode: "dark", accent: "#d97706", tint: "#3b2a18", bubble: "match", corners: "sharp" };

describe("CustomSkinManager", () => {
  it("creates a skin from tool-shaped input and emits a frame", () => {
    const events: unknown[] = [];
    const manager = new CustomSkinManager({ file: tempFile(), emit: (e) => events.push(e) });
    const { skin, replaced } = manager.save(AMBER, { botId: "b1", name: "Kero" });
    expect(replaced).toBe(false);
    expect(skin.id).toMatch(/^cs-[0-9a-f]{8}$/);
    expect(skin.name).toBe("Ember");
    expect(skin.createdBy).toEqual({ botId: "b1", name: "Kero" });
    expect(events).toEqual([{ kind: "skin", skin }]);
  });

  it("replaces by name so the agent can iterate, keeping the id and author", () => {
    const manager = new CustomSkinManager({ file: tempFile() });
    const first = manager.save(AMBER, { botId: "b1", name: "Kero" }).skin;
    const second = manager.save({ ...AMBER, accent: "#f59e0b" }).skin;
    expect(second.id).toBe(first.id);
    expect(second.recipe.accent).toBe("#f59e0b");
    expect(second.createdBy).toEqual({ botId: "b1", name: "Kero" });
    expect(manager.list()).toHaveLength(1);
  });

  it("rejects bad input with the parse error and saves nothing", () => {
    const manager = new CustomSkinManager({ file: tempFile() });
    expect(() => manager.save({ name: "X", mode: "twilight", accent: "#ffffff" })).toThrow(/mode/);
    expect(manager.list()).toEqual([]);
  });

  it("round-trips through the JSON file", () => {
    const file = tempFile();
    const writer = new CustomSkinManager({ file });
    const created = writer.save({ ...AMBER, tagline: "Warm brass" }).skin;
    const reader = new CustomSkinManager({ file });
    expect(reader.get(created.id)?.tagline).toBe("Warm brass");
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.version).toBe(1);
    expect(onDisk.skins[0].recipe.mode).toBe("dark");
  });

  it("ignores a corrupt file instead of refusing to start", () => {
    const file = tempFile();
    const writer = new CustomSkinManager({ file });
    writer.save(AMBER);
    // Someone hand-edited the file into nonsense; the server must still boot.
    writeFileSync(file, "{ not json");
    expect(new CustomSkinManager({ file }).list()).toEqual([]);
  });

  it("caps the collection", () => {
    const manager = new CustomSkinManager({ file: tempFile() });
    for (let i = 0; i < 24; i++) manager.save({ ...AMBER, name: `Skin ${i}` });
    expect(() => manager.save({ ...AMBER, name: "One too many" })).toThrow(/At most 24/);
  });

  it("updates display fields by id, refuses a name clash, and nulls on a missing id", () => {
    const manager = new CustomSkinManager({ file: tempFile() });
    manager.save(AMBER);
    const b = manager.save({ ...AMBER, name: "Other" }).skin;
    const updated = manager.update(b.id, { name: "Renamed", tagline: "New line" });
    expect(updated?.name).toBe("Renamed");
    expect(updated?.tagline).toBe("New line");
    expect(() => manager.update(b.id, { name: "ember" })).toThrow(/already exists/);
    expect(manager.update("cs-00000000", { name: "Ghost" })).toBeNull();
  });

  it("patches the recipe through update, keeping the author", () => {
    const manager = new CustomSkinManager({ file: tempFile() });
    const skin = manager.save(AMBER, { botId: "b1", name: "Kero" }).skin;
    const updated = manager.update(skin.id, { recipe: { ...AMBER, mode: "light" } });
    expect(updated?.recipe.mode).toBe("light");
    expect(updated?.createdBy).toEqual({ botId: "b1", name: "Kero" });
  });

  it("removes and emits the deletion", () => {
    const events: CustomSkinManagerEvent[] = [];
    const manager = new CustomSkinManager({ file: tempFile(), emit: (e) => events.push(e) });
    const skin = manager.save(AMBER).skin;
    expect(manager.remove(skin.id)).toBe(true);
    expect(manager.remove(skin.id)).toBe(false);
    expect(events.map((e) => e.kind)).toEqual(["skin", "skin.deleted"]);
    expect(events[1]).toEqual({ kind: "skin.deleted", skinId: skin.id });
  });
});

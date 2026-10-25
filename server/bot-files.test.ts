import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { botFolderBrowser } from "./bot-files.ts";

const suite = realpathSync(mkdtempSync(join(tmpdir(), "omb-bot-folders-")));
const home = join(suite, "home");
const project = join(home, "work", "project");
const data = join(home, ".openmausbot");
const shared = join(data, "workspaces", "scout");
const thread = join(data, "task-workspaces", "scout", "thread-1");

beforeEach(() => {
  rmSync(suite, { recursive: true, force: true });
  for (const folder of [project, shared, thread, join(data, "workspaces", "other"), join(data, "task-workspaces", "scout", "thread-2")]) {
    mkdirSync(folder, { recursive: true });
  }
  writeFileSync(join(data, "config.json"), "{\"token\":\"secret\"}");
  writeFileSync(join(home, "notes.md"), "# notes");
  writeFileSync(join(suite, "outside.txt"), "above home");
});
afterAll(() => rmSync(suite, { recursive: true, force: true }));

const scope = (roots: string[], options: { home?: string | null } = {}) => ({
  roots,
  ownFolders: [shared, join(data, "task-workspaces", "scout")],
  dataDir: data,
  home: options.home === undefined ? home : options.home,
});

describe("a bot's folder browser", () => {
  it("climbs from the working folder up to the home folder and no further", async () => {
    const browser = botFolderBrowser(scope([project, shared]));
    await expect(browser.list({ root: 0, up: 0, path: "" })).resolves.toMatchObject({ base: project, canGoUp: true });
    await expect(browser.list({ root: 0, up: 2, path: "" })).resolves.toMatchObject({ base: home, canGoUp: false, entries: [{ name: "notes.md" }] });
    await expect(browser.list({ root: 0, up: 3, path: "" })).rejects.toMatchObject({ status: 403 });
    await expect(browser.list({ root: 0, up: 2, path: ".." })).rejects.toMatchObject({ status: 400 });
  });

  it("hides the app's data folder except the bot's own folders", async () => {
    const browser = botFolderBrowser(scope([project, shared]));
    const top = await browser.list({ root: 0, up: 2, path: "" });
    expect(top.folders).toEqual(["work"]);
    await expect(browser.list({ root: 0, up: 2, path: ".openmausbot" })).rejects.toMatchObject({ status: 403 });
    await expect(browser.open({ root: 0, up: 2, path: ".openmausbot/config.json" })).rejects.toMatchObject({ status: 403 });

    symlinkSync(data, join(project, "sneaky"));
    expect((await browser.list({ root: 0, up: 0, path: "" })).folders).not.toContain("sneaky");
    await expect(browser.open({ root: 0, up: 0, path: "sneaky/config.json" })).rejects.toMatchObject({ status: 403 });
  });

  it("lets a private thread folder climb to the bot's other threads but not into the data folder", async () => {
    const browser = botFolderBrowser(scope([thread, shared]));
    await expect(browser.list({ root: 0, up: 1, path: "" })).resolves.toMatchObject({ folders: ["thread-1", "thread-2"], canGoUp: false });
    await expect(browser.list({ root: 0, up: 2, path: "" })).rejects.toMatchObject({ status: 403 });
  });

  it("never climbs on a server without a home to browse, or from the shared folder", async () => {
    await expect(botFolderBrowser(scope([project, shared], { home: null })).list({ root: 0, up: 0, path: "" })).resolves.toMatchObject({ canGoUp: false });
    await expect(botFolderBrowser(scope([project, shared], { home: null })).list({ root: 0, up: 1, path: "" })).rejects.toMatchObject({ status: 403 });
    const browser = botFolderBrowser(scope([project, shared]));
    await expect(browser.list({ root: 1, up: 0, path: "" })).resolves.toMatchObject({ base: shared, canGoUp: false });
    await expect(browser.list({ root: 1, up: 1, path: "" })).rejects.toMatchObject({ status: 403 });
    await expect(browser.list({ root: 2, up: 0, path: "" })).rejects.toMatchObject({ status: 404 });
  });
});

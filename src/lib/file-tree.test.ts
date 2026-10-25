import { describe, expect, it } from "vitest";
import type { Bot, Message } from "@/state/store";

import { changedFileMarks, climbedState, readFileTreeState, treeRows, writeFileTreeState, type FileTreeState, type FolderListing } from "./file-tree";

const digest = (id: string, files: { added?: string[]; changed?: string[]; deleted?: string[] }) => ({
  id, role: "bot", kind: "digest", at: 1, digest: { files: { added: [], changed: [], deleted: [], ...files } },
}) as unknown as Message;
const bot = (messages: Message[], patch: Partial<Bot> = {}) => ({ id: "scout", threadId: "t1", cwd: "/work", messages, ...patch }) as Bot;

describe("changed-file marks", () => {
  it("keeps a file added then changed as added, drops deleted files, and resolves relative paths in the chat's folder", () => {
    const marks = changedFileMarks(bot([
      digest("1", { added: ["/work/new.md", "/work/gone.md"], changed: ["old.md"] }),
      digest("2", { changed: ["/work/new.md"], deleted: ["/work/gone.md"] }),
    ]));
    expect(marks.files).toEqual(new Map([["/work/new.md", "A"], ["/work/old.md", "M"]]));
    expect(marks.folders.has("/work")).toBe(true);
    expect(marks.folders.has("/")).toBe(false);
  });

  it("ignores relative paths when the chat has no folder", () => {
    expect(changedFileMarks(bot([digest("1", { changed: ["old.md"] })], { cwd: undefined })).files.size).toBe(0);
  });
});

describe("tree rows", () => {
  const listings = new Map<string, FolderListing>([
    ["0:", { folders: ["renders"], entries: [{ name: "a.md", bytes: 1, mime: "text/markdown" }], truncated: false }],
    ["0:renders", { folders: [], entries: [{ name: "clip.mp4", bytes: 2, mime: "video/mp4" }], truncated: true }],
  ]);

  it("lists expanded folders depth-first with folders before files, and keeps the shared root collapsed", () => {
    const state: FileTreeState = { up: 0, expanded: ["0:", "0:renders"], opened: null };
    const rows = treeRows(["project", "Shared folder"], state, listings, new Map());
    expect(rows.map((row) => `${row.depth}:${row.kind}:${row.kind === "note" ? row.note : row.name}`)).toEqual([
      "0:folder:project", "1:folder:renders", "2:file:clip.mp4", "2:note:truncated", "1:file:a.md", "0:folder:Shared folder",
    ]);
  });

  it("shows a loading row for an expanded folder not listed yet, and its error when listing failed", () => {
    const rows = treeRows(["project"], { up: 0, expanded: ["0:", "0:renders", "0:missing"], opened: null }, new Map([["0:", { folders: ["missing", "renders"], entries: [], truncated: false }]]), new Map([["0:missing", "gone"]]));
    expect(rows.filter((row) => row.kind === "note").map((row) => row.kind === "note" && row.note)).toEqual(["gone", "loading"]);
  });
});

describe("going up a folder", () => {
  it("keeps what was expanded and open, now under the old folder's name", () => {
    const state: FileTreeState = { up: 0, expanded: ["0:", "0:renders", "1:"], opened: { root: 0, path: "renders/clip.mp4", mime: "video/mp4", bytes: 2 } };
    expect(climbedState(state, "project")).toEqual({
      up: 1,
      expanded: ["0:", "0:project", "0:project/renders", "1:"],
      opened: { root: 0, path: "project/renders/clip.mp4", mime: "video/mp4", bytes: 2 },
    });
  });
});

describe("remembered tree", () => {
  it("round-trips per bot and chat, and falls back for missing or broken values", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const state: FileTreeState = { up: 2, expanded: ["0:", "0:a"], opened: null };
    writeFileTreeState("scout", "t1", state, storage);
    expect(readFileTreeState("scout", "t1", storage)).toEqual(state);
    expect(readFileTreeState("scout", "t2", storage)).toEqual({ up: 0, expanded: ["0:"], opened: null });
    values.set("omb-file-tree:scout:t2", "{not json");
    expect(readFileTreeState("scout", "t2", storage)).toEqual({ up: 0, expanded: ["0:"], opened: null });
  });
});

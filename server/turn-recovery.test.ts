import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb, deleteThread, readRunningTurns, saveRunningTurn, retireRunningTurn } from "./message-db.ts";

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
});

it("durably replaces a dispatch and fences late completion from its predecessor", () => {
  const turn = { threadId: "thread", ownerId: "bot", kind: "bot" as const, generation: "old", sourceMessageId: "ask", startedAt: 123 };
  saveRunningTurn(turn);
  closeMessageDb();
  expect(readRunningTurns()).toEqual([turn]);
  saveRunningTurn({ ...turn, generation: "new" });
  retireRunningTurn("thread", "old");
  expect(readRunningTurns()).toEqual([{ ...turn, generation: "new" }]);
  retireRunningTurn("thread", "new");
  closeMessageDb();
  expect(readRunningTurns()).toEqual([]);
});

it("thread deletion removes its recovery record without touching another chat", () => {
  for (const threadId of ["a", "b"]) saveRunningTurn({ threadId, kind: "bot", ownerId: "bot", generation: threadId, sourceMessageId: "ask", startedAt: 123 });
  deleteThread("a");
  expect(readRunningTurns().map(row => row.threadId)).toEqual(["b"]);
});

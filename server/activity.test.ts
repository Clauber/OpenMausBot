// A bot's activity log: what it did, in plain words, with the outcome. Two
// logs already on disk feed it — the per-thread runtime events (what ran,
// did it finish) and the fleet-wide decision log (what was asked, with
// which arguments, and who said yes). These tests pin the merge: one row
// per thing that happened, never one per log that saw it.
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { describeTool, readBotActivity, type ActivityRow } from "./activity.ts";
import type { DecisionRow } from "./decision-log.ts";
import type { WireMessage } from "../shared/wire.ts";
import { removeTempDir } from "./testing/cleanup.ts";

describe("describeTool", () => {
  it("names the built-in agent tools as actions", () => {
    expect(describeTool("Bash")).toEqual({ app: null, label: "Ran a command" });
    expect(describeTool("Read")).toEqual({ app: null, label: "Read a file" });
    expect(describeTool("Edit")).toEqual({ app: null, label: "Edited a file" });
    expect(describeTool("Write")).toEqual({ app: null, label: "Wrote a file" });
    expect(describeTool("WebSearch")).toEqual({ app: null, label: "Searched the web" });
  });

  it("splits an MCP connector tool into the app and the action", () => {
    expect(describeTool("mcp__claude_ai_Gmail__search_threads")).toEqual({ app: "Gmail", label: "Search threads" });
    expect(describeTool("mcp__claude_ai_Linear__save_issue")).toEqual({ app: "Linear", label: "Save issue" });
    expect(describeTool("mcp__claude_ai_Google_Calendar__list_events")).toEqual({ app: "Google Calendar", label: "List events" });
  });

  it("reads Composio's upper-case toolkit names", () => {
    expect(describeTool("GMAIL_SEND_EMAIL")).toEqual({ app: "Gmail", label: "Send email" });
    expect(describeTool("mcp__composio__GITHUB_CREATE_AN_ISSUE")).toEqual({ app: "GitHub", label: "Create an issue" });
    expect(describeTool("GOOGLESHEETS_BATCH_UPDATE")).toEqual({ app: "Google Sheets", label: "Batch update" });
  });

  it("treats the bot's computer and its teammates as apps too", () => {
    expect(describeTool("mcp__computer__click")).toEqual({ app: "Computer", label: "Click" });
    expect(describeTool("mcp__agents__delegate_bot")).toEqual({ app: "Team", label: "Delegate bot" });
  });

  it("falls back to spacing out an unknown name rather than showing it raw", () => {
    expect(describeTool("TaskUpdate")).toEqual({ app: null, label: "Task update" });
    expect(describeTool("replace_file_content")).toEqual({ app: null, label: "Replace file content" });
  });
});

let dataDir: string;
let eventsDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "omb-activity-"));
  eventsDir = join(dataDir, "events");
  mkdirSync(eventsDir);
});

afterEach(async () => {
  await removeTempDir(dataDir);
});

const decision = (row: Partial<DecisionRow> & Pick<DecisionRow, "at">) => {
  const full: DecisionRow = {
    threadId: "t1",
    botId: "b1",
    botName: "Scout",
    tool: "Bash",
    decision: "auto-approved",
    source: "command-allowlist",
    ...row,
  };
  appendFileSync(join(dataDir, "decisions.ndjson"), JSON.stringify(full) + "\n");
};

let eventSeq = 0;
const event = (threadId: string, createdAt: string, body: Record<string, unknown>) => {
  const full = {
    eventId: `e${++eventSeq}`,
    provider: "claude",
    threadId,
    createdAt,
    turnId: "turn-1",
    ...body,
  };
  appendFileSync(join(eventsDir, `${threadId}.ndjson`), JSON.stringify(full) + "\n");
};

const toolRun = (threadId: string, itemId: string, tool: string, startedAt: string, ok: boolean | null) => {
  event(threadId, startedAt, { type: "item.started", itemType: "tool", itemId, title: tool });
  if (ok !== null) {
    const done = new Date(new Date(startedAt).getTime() + 1500).toISOString();
    event(threadId, done, { type: "item.completed", itemType: "tool", itemId, ok });
  }
};

let stored: WireMessage[] = [];
beforeEach(() => { stored = []; });
const toolMessage = (itemId: string, turnId: string | undefined, tool: Partial<NonNullable<WireMessage["tool"]>> = {}) =>
  stored.push({ id: `m-${itemId}-${turnId}`, at: 0, role: "bot", kind: "activity", ...(turnId ? { turnId } : {}), tool: { name: "Bash", itemId, ...tool } });

const read = (overrides: Partial<Parameters<typeof readBotActivity>[0]> = {}): ActivityRow[] =>
  readBotActivity({ dataDir, eventsDir, botId: "b1", threadIds: ["t1"], limit: 50, messagesFor: (threadId) => threadId === "t1" ? stored : [], ...overrides });

describe("readBotActivity", () => {
  it("turns a finished tool item into one row that says it ran", () => {
    toolRun("t1", "i1", "Read", "2026-09-07T09:00:00.000Z", true);
    expect(read()).toEqual([
      expect.objectContaining({ at: "2026-09-07T09:00:00.000Z", threadId: "t1", tool: "Read", label: "Read a file", outcome: "ran" }),
    ]);
  });

  it("marks a tool that finished badly as failed, and one still going as running", () => {
    toolRun("t1", "i1", "Bash", "2026-09-07T09:00:00.000Z", false);
    toolRun("t1", "i2", "WebSearch", "2026-09-07T09:01:00.000Z", null);
    expect(read().map((row) => [row.tool, row.outcome])).toEqual([
      ["WebSearch", "running"],
      ["Bash", "failed"],
    ]);
  });

  it("keeps reused provider item IDs separate across turns, including legacy no-turn events", () => {
    for (const [turnId, tool, ok, minute] of [["turn-one", "Read", true, "00"], ["turn-two", "Bash", false, "01"], [undefined, "Edit", true, "02"]] as const) {
      event("t1", `2026-09-07T09:${minute}:00.000Z`, { type: "item.started", itemType: "tool", itemId: "item_0", turnId, title: tool });
      event("t1", `2026-09-07T09:${minute}:01.000Z`, { type: "item.completed", itemType: "tool", itemId: "item_0", turnId, ok });
    }
    expect(read().map(row => [row.tool, row.turnId, row.outcome])).toEqual([
      ["Edit", undefined, "ran"], ["Bash", "turn-two", "failed"], ["Read", "turn-one", "ran"],
    ]);
  });

  it("folds the approval that let a tool run into the tool's own row, with its arguments", () => {
    decision({ at: "2026-09-07T09:00:00.000Z", requestId: "r1", tool: "Bash", summary: "git status" });
    toolRun("t1", "i1", "Bash", "2026-09-07T09:00:00.400Z", true);
    const rows = read();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "Bash", summary: "git status", outcome: "ran", requestId: "r1" });
  });

  it("keeps a denied request as its own row, since nothing ran", () => {
    decision({ at: "2026-09-07T09:00:00.000Z", requestId: "r1", tool: "Bash", summary: "rm -rf build", decision: "card-shown", source: "question" });
    decision({ at: "2026-09-07T09:00:05.000Z", requestId: "r1", tool: "Bash", summary: "rm -rf build", decision: "user-denied", source: "user" });
    expect(read()).toEqual([
      expect.objectContaining({ tool: "Bash", summary: "rm -rf build", outcome: "denied", requestId: "r1" }),
    ]);
  });

  it("shows a card nobody has answered as waiting", () => {
    decision({ at: "2026-09-07T09:00:00.000Z", requestId: "r1", tool: "mcp__claude_ai_Gmail__send_email", summary: "to finance@", decision: "card-shown", source: "question" });
    expect(read()).toEqual([
      expect.objectContaining({ app: "Gmail", label: "Send email", outcome: "waiting" }),
    ]);
  });

  it("does not attach an approval to a different tool, or to a run long after it", () => {
    decision({ at: "2026-09-07T09:00:00.000Z", requestId: "r1", tool: "Bash", summary: "git status" });
    toolRun("t1", "i1", "Read", "2026-09-07T09:00:00.400Z", true);
    toolRun("t1", "i2", "Bash", "2026-09-07T09:05:00.000Z", true);
    const rows = read();
    expect(rows.map((row) => [row.tool, row.outcome, row.summary ?? null])).toEqual([
      ["Bash", "ran", null],
      ["Read", "ran", null],
      ["Bash", "allowed", "git status"],
    ]);
  });

  it("ignores other bots' decisions and threads it was not asked about", () => {
    decision({ at: "2026-09-07T09:00:00.000Z", requestId: "r1", botId: "b2", summary: "not mine" });
    toolRun("t2", "i1", "Read", "2026-09-07T09:00:00.000Z", true);
    toolRun("t1", "i2", "Edit", "2026-09-07T09:01:00.000Z", true);
    expect(read().map((row) => row.tool)).toEqual(["Edit"]);
  });

  it("returns newest first and honors the limit", () => {
    for (let i = 0; i < 5; i++) {
      toolRun("t1", `i${i}`, "Read", `2026-09-07T09:0${i}:00.000Z`, true);
    }
    expect(read({ limit: 2 }).map((row) => row.at)).toEqual([
      "2026-09-07T09:04:00.000Z",
      "2026-09-07T09:03:00.000Z",
    ]);
  });

  it("carries the chat message's tool details for the same turn and item, running or finished", () => {
    toolRun("t1", "i1", "Bash", "2026-09-07T09:00:00.000Z", false);
    toolRun("t1", "i2", "Bash", "2026-09-07T09:01:00.000Z", null);
    toolMessage("i1", "turn-1", { input: "npm test", output: "1 failed", ok: false });
    toolMessage("i2", "turn-1", { input: "sleep 60" });
    expect(read().map((row) => [row.outcome, row.detail])).toEqual([
      ["running", { name: "Bash", itemId: "i2", input: "sleep 60" }],
      ["failed", { name: "Bash", itemId: "i1", input: "npm test", output: "1 failed", ok: false }],
    ]);
  });

  it("never borrows another turn's message for a reused item ID, and skips an ambiguous legacy run", () => {
    for (const [turnId, minute] of [["turn-one", "00"], ["turn-two", "01"], [undefined, "02"]] as const) {
      event("t1", `2026-09-07T09:${minute}:00.000Z`, { type: "item.started", itemType: "tool", itemId: "item_0", turnId, title: "Bash" });
    }
    toolMessage("item_0", "turn-one", { input: "first" });
    toolMessage("item_0", "turn-three", { input: "elsewhere" });
    expect(read().map((row) => [row.turnId, row.detail?.input])).toEqual([
      [undefined, undefined], ["turn-two", undefined], ["turn-one", "first"],
    ]);
  });

  it("keeps identical turn and item IDs isolated by thread", () => {
    toolRun("t1", "same", "Bash", "2026-09-07T09:00:00.000Z", true);
    toolRun("t2", "same", "Bash", "2026-09-07T09:01:00.000Z", true);
    toolMessage("same", "turn-1", { input: "first thread" });
    const calls: string[] = [];
    const rows = read({
      threadIds: ["t1", "t2"],
      messagesFor: (threadId) => {
        calls.push(threadId);
        return threadId === "t1" ? stored : [{ ...stored[0], tool: { ...stored[0].tool!, input: "second thread" } }];
      },
    });
    expect(rows.map((row) => [row.threadId, row.detail?.input])).toEqual([
      ["t2", "second thread"], ["t1", "first thread"],
    ]);
    expect(calls).toEqual(["t1", "t2"]);
  });

  it("omits details when multiple messages carry the exact same identity", () => {
    toolRun("t1", "same", "Bash", "2026-09-07T09:00:00.000Z", true);
    toolMessage("same", "turn-1", { input: "first" });
    toolMessage("same", "turn-1", { input: "second" });
    expect(read()[0].detail).toBeUndefined();
  });

  it("gives a legacy run without a turn the one message that carries its item ID", () => {
    event("t1", "2026-09-07T09:00:00.000Z", { type: "item.started", itemType: "tool", itemId: "solo", turnId: undefined, title: "Bash" });
    toolMessage("solo", "turn-9", { input: "ls" });
    expect(read()[0].detail?.input).toBe("ls");
  });

  it("is empty, not an error, when no log exists yet", () => {
    expect(read()).toEqual([]);
  });
});

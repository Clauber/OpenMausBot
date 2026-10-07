import { describe, expect, it } from "vitest";
import type { ChatGoal } from "../shared/chat-goal.ts";
import { chatGoalCommand } from "../shared/chat-goal.ts";
import { ChatGoals, type ChatGoalOutcome } from "./chat-goals.ts";

const turn = (status: string, detail = "Verified output") => ({ ok: true, text:
  `Result\n<openmaus-goal>${JSON.stringify({ status, detail, ...(status === "continue" ? { next: "self", instruction: detail } : {}) })}</openmaus-goal>` });
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture() {
  const saved = new Map<string, ChatGoal>();
  const pending: Array<(outcome: ChatGoalOutcome) => void> = [];
  const goals = new ChatGoals({
    targets: () => [...saved].map(([threadId, goal]) => ({ botId: "bot", threadId, goal })),
    read: (_bot, thread) => saved.get(thread),
    save: (_bot, thread, goal) => { saved.set(thread, structuredClone(goal)); },
    canRun: () => true,
    run: () => new Promise(resolve => pending.push(resolve)),
  });
  return { saved, pending, goals };
}

describe("persistent chat goals", () => {
  it("parses lifecycle commands without mistaking normal conversation for a command", () => {
    expect(chatGoalCommand("/goal verify the release")).toEqual({ action: "start", objective: "verify the release" });
    expect(chatGoalCommand("/goal")).toEqual({ action: "status" });
    expect(chatGoalCommand("/goal pause")).toEqual({ action: "pause" });
    expect(chatGoalCommand("discuss /goal later")).toBeNull();
    expect(chatGoalCommand("/goalie")).toBeNull();
  });

  it("continues after progress and ends on a completion with evidence", async () => {
    const f = fixture();
    f.goals.start("bot", "chat", "Ship", "source");
    await tick();
    f.pending.shift()!(turn("continue", "Built artifacts; verify them next"));
    await tick();
    expect(f.saved.get("chat")).toMatchObject({ status: "active", turns: 2 });
    f.pending.shift()!(turn("completed"));
    await tick();
    expect(f.saved.get("chat")).toMatchObject({ status: "completed", turns: 2, detail: "Verified output" });
    expect(f.pending).toHaveLength(0);
  });

  it("fences late completion after pause and allows resume in the same chat", async () => {
    const f = fixture();
    f.goals.start("bot", "chat", "Ship", "source");
    await tick();
    f.goals.control("bot", "chat", "pause");
    f.pending.shift()!(turn("completed"));
    await tick();
    expect(f.saved.get("chat")?.status).toBe("paused");
    f.goals.control("bot", "chat", "resume");
    await tick();
    expect(f.pending).toHaveLength(1);
    f.goals.control("bot", "chat", "stop");
    f.pending.shift()!(turn("continue"));
    await tick();
    expect(f.saved.get("chat")?.status).toBe("stopped");
    expect(f.pending).toHaveLength(0);
  });

  it("keeps a goal active across a model-changing steer and isolates sibling chats", async () => {
    const f = fixture();
    f.goals.start("bot", "chat", "Ship", "source");
    f.goals.start("bot", "sibling", "Research", "other-source");
    await tick();
    f.goals.steer("bot", "chat");
    f.pending.shift()!({ ok: false, text: "interrupted" });
    f.pending.shift()!(turn("completed"));
    await tick();
    expect(f.saved.get("chat")?.status).toBe("active");
    expect(f.saved.get("sibling")?.status).toBe("completed");
    expect(f.pending).toHaveLength(1);
  });

  it("stops on provider failure or three malformed/no-progress replies", async () => {
    const f = fixture();
    f.goals.start("bot", "chat", "Ship", "source");
    for (let i = 0; i < 3; i++) {
      await tick(); f.pending.shift()!({ ok: true, text: "I will continue" });
    }
    await tick();
    expect(f.saved.get("chat")).toMatchObject({ status: "blocked", turns: 3 });
    f.goals.control("bot", "chat", "resume");
    await tick(); f.pending.shift()!({ ok: false, text: "Quota exceeded" });
    await tick();
    expect(f.saved.get("chat")).toMatchObject({ status: "blocked", detail: "Quota exceeded" });
  });

  it("does not resurrect an ended goal through pause or a repeated resume", async () => {
    const f = fixture();
    f.goals.start("bot", "chat", "Ship", "source");
    await tick();
    const epoch = f.saved.get("chat")!.epoch;
    f.goals.control("bot", "chat", "resume");
    expect(f.saved.get("chat")!.epoch).toBe(epoch);
    f.pending.shift()!(turn("completed"));
    await tick();
    f.goals.control("bot", "chat", "pause");
    expect(f.saved.get("chat")?.status).toBe("completed");
    expect(() => f.goals.control("bot", "chat", "resume")).toThrow("has ended");
  });
});

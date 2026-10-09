import { describe, expect, it } from "vitest";
import { draggedBot, placeBot } from "./bot-order";
import { initialState, reducer } from "@/state/store";

describe("bot subtree ordering", () => {
  it("moves a bot with its threads and leaves unrelated records intact", () => {
    const bots = [{ id: "a", threadId: "ta", tasks: [{ threadId: "ta" }] }, { id: "b", threadId: "tb", tasks: [{ threadId: "tb" }, { threadId: "older" }] }];
    const order = placeBot(bots.map(bot => bot.id), "b", "a", "before");
    const state = reducer({ ...initialState, bots: bots as typeof initialState.bots }, { type: "botsOrdered", botIds: order });
    expect(state.bots).toEqual([bots[1], bots[0]]);
    expect(state.bots[0]).toBe(bots[1]);
    expect(draggedBot(JSON.stringify({ botId: "b", threadId: "older", fromPinned: true }), bots)).toEqual({ botId: "b", threadId: "older", fromPinned: true });
    expect(draggedBot(JSON.stringify({ botId: "b", threadId: "ta", fromPinned: true }), bots)).toBeNull();
  });
});

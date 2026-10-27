import { describe, expect, it } from "vitest";
import { initialState, reducer, type Bot } from "./store";

const alpha: Bot = {
  id: "alpha", name: "Alpha", color: "green", threadId: "a1", title: "",
  description: "", notifications: true, unread: false, messages: [],
  modelSelection: { instanceId: "fake", model: "fake" },
  tasks: [{ threadId: "a1", title: "One", createdAt: 1 }, { threadId: "a2", title: "Two", createdAt: 2 }],
};
const beta: Bot = { ...alpha, id: "beta", name: "Beta", threadId: "b1" };

describe("bot-scoped settings panel", () => {
  it("opens explicit bot targets with their own section and preserves other bot choices", () => {
    let state = { ...initialState, bots: [alpha, beta], selectedId: alpha.id };
    state = reducer(state, { type: "toggleSettings", section: "soul" });
    state = reducer(state, { type: "toggleSettings", botId: beta.id, section: "identity" });
    state = reducer(state, { type: "toggleSettings", botId: alpha.id });
    expect(state).toMatchObject({ selectedId: alpha.id, settingsOpen: true, botSettingsSection: "soul", botSettingsExpandAccordion: true });
  });

  it("keeps computer state and honors computer actions after cross-bot navigation", () => {
    let state = { ...initialState, bots: [alpha, beta], selectedId: beta.id };
    state = reducer(state, { type: "toggleSettings", section: "identity" });
    state = reducer(state, { type: "select", id: alpha.id });
    state = reducer(state, { type: "openDataResult", botId: beta.id, cardId: "fixture" });
    expect(state).toMatchObject({ selectedId: beta.id, computerOpen: true, settingsOpen: false, botSettingsSection: "identity" });
    state = reducer(state, { type: "select", id: alpha.id });
    expect(state.computerOpen).toBe(true);
  });

  it("restores open, closed and section choices independently across bots", () => {
    let state = { ...initialState, bots: [alpha, beta], selectedId: alpha.id };
    state = reducer(state, { type: "toggleSettings", open: true, section: "soul" });
    state = reducer(state, { type: "select", id: beta.id });
    expect(state).toMatchObject({ settingsOpen: false, botSettingsSection: "overview", botSettingsExpandAccordion: false });
    state = reducer(state, { type: "toggleSettings", open: true, section: "identity" });
    state = reducer(state, { type: "toggleSettings", open: false });
    state = reducer(state, { type: "select", id: alpha.id });
    expect(state).toMatchObject({ settingsOpen: true, botSettingsSection: "soul", botSettingsExpandAccordion: true });
    state = reducer(state, { type: "select", id: beta.id });
    expect(state).toMatchObject({ settingsOpen: false, botSettingsSection: "identity" });
  });

  it("keeps collapsed accordion and same-bot thread state", () => {
    let state = { ...initialState, bots: [alpha, beta], selectedId: alpha.id };
    state = reducer(state, { type: "toggleSettings", open: true, section: "soul" });
    state = reducer(state, { type: "toggleSettings", open: true });
    state = reducer(state, { type: "switchTask", botId: alpha.id, threadId: "a2" });
    expect(state).toMatchObject({ settingsOpen: true, botSettingsSection: "soul", botSettingsExpandAccordion: false });
    state = reducer(state, { type: "select", id: beta.id });
    state = reducer(state, { type: "select", id: alpha.id });
    expect(state).toMatchObject({ settingsOpen: true, botSettingsSection: "soul", botSettingsExpandAccordion: false });
  });

  it("restores the surviving bot after deletion and closes when no bot remains", () => {
    let state = { ...initialState, bots: [alpha, beta], selectedId: alpha.id };
    state = reducer(state, { type: "toggleSettings", open: true, section: "soul" });
    state = reducer(state, { type: "deleteBot", botId: alpha.id });
    expect(state).toMatchObject({ selectedId: beta.id, settingsOpen: false, botSettingsSection: "overview" });
    state = reducer(state, { type: "toggleSettings", open: true, section: "identity" });
    state = reducer(state, { type: "deleteBot", botId: beta.id });
    expect(state).toMatchObject({ selectedId: "", settingsOpen: false });
  });
});

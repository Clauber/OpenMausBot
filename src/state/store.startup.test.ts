import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StoreProvider, useStore, type AppState } from "./store";

let root: Root | undefined;
let testWindow: Window | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  await testWindow?.happyDOM.close();
  vi.unstubAllGlobals();
});

it("hydrates real store chat independently, bounds peripherals, and discards a snapshot older than live routine frames", async () => {
  testWindow = new Window({ url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "localStorage", "HTMLElement"]) {
    vi.stubGlobal(key, Reflect.get(testWindow, key === "window" ? "self" : key));
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const sources: FixtureSource[] = [];
  class FixtureSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
    constructor(readonly url: string) { sources.push(this); }
    close() {}
    message(frame: unknown, lastEventId = "") { this.onmessage?.({ data: JSON.stringify(frame), lastEventId }); }
  }
  vi.stubGlobal("EventSource", FixtureSource);
  let resolveRoutines!: (response: Response) => void;
  let resolveChat!: (response: Response) => void;
  const signals = new Map<string, AbortSignal>();
  const fetchImpl = vi.fn((input: string, init?: RequestInit) => {
    if (init?.signal) signals.set(input, init.signal);
    if (input.startsWith("/api/bots?")) return new Promise<Response>((resolve) => { resolveChat = resolve; });
    if (input === "/api/routines") return new Promise<Response>((resolve) => { resolveRoutines = resolve; });
    if (input === "/api/webhooks") return new Promise<Response>(() => {});
    return Promise.resolve(Response.json(input === "/api/instances" ? { instances: [] } : {}));
  });
  const deadline = vi.spyOn(AbortSignal, "timeout");
  vi.stubGlobal("fetch", fetchImpl);
  let state!: AppState;
  function Capture() { state = useStore().state; return null; }
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
  await act(async () => root!.render(createElement(StoreProvider, null, createElement(Capture))));
  await act(async () => {
    sources[0]!.message({ kind: "hello", resumed: false, cursor: "stream00:4" });
    sources[0]!.message({ kind: "routine", routine: { id: "r1", name: "Live routine" } }, "stream00:5");
  });
  expect(state.routines).toEqual([]);
  // The requests above were already issued; their signals prove all optional
  // lanes have deadlines while neither stalled lane blocks the live fold.
  for (const path of ["instances", "config", "routines", "webhooks"]) {
    expect(signals.get(`/api/${path}`)).toBeInstanceOf(AbortSignal);
  }
  await act(async () => {
    resolveChat(Response.json({ bots: [], groups: [], sections: [{ id: "s1", name: "Snapshot" }] }));
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
  expect(deadline.mock.calls).toEqual([[10_000], [10_000], [10_000], [10_000]]);
  deadline.mockRestore();
  expect(state.sections).toEqual([{ id: "s1", name: "Snapshot" }]);
  expect(state.routines).toMatchObject([{ id: "r1", name: "Live routine" }]);
  await act(async () => {
    resolveRoutines(Response.json({ routines: [], runs: [] }));
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
  expect(state.routines).toMatchObject([{ id: "r1", name: "Live routine" }]);
});

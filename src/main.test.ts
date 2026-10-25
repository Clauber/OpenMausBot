import { Window } from "happy-dom";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ unmount: null as (() => void) | null, events: [] as string[], session: undefined as unknown }));
vi.mock("react-dom/client", async (original) => {
  const actual = await original<typeof import("react-dom/client")>();
  return { createRoot: (...args: Parameters<typeof actual.createRoot>) => {
    const root = actual.createRoot(...args);
    fixture.unmount = () => root.unmount();
    return { render: (...renderArgs: Parameters<typeof root.render>) => {
      fixture.events.push("mount");
      root.render(...renderArgs);
    } };
  } };
});
vi.mock("./App", () => ({ default: ({ initialSession }: { initialSession: unknown }) => {
  fixture.session = initialSession;
  return "Chat app";
} }));
vi.mock("./pair/PairPage", () => ({ PairPage: ({ reason }: { reason?: string }) => `Pair browser: ${reason ?? ""}` }));
vi.mock("./pair/BrowserSignInPage", () => ({ BrowserSignInPage: ({ owner }: { owner: string }) => `Continue as ${owner}` }));
vi.mock("./lib/brand", () => ({ bootstrapBrand: async () => { fixture.events.push("brand"); } }));
vi.mock("./lib/skins", () => ({ applySkin: vi.fn(), readSkin: vi.fn() }));
vi.mock("./lib/fonts", () => ({ applyFont: vi.fn(), readFont: vi.fn() }));
vi.mock("./lib/interface-mode", () => ({ settleAdvancedModeDefault: vi.fn() }));

let testWindow: Window;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  testWindow = new Window({ url: "http://localhost/" });
  for (const key of ["window", "document", "history", "location", "HTMLElement", "navigator"]) {
    vi.stubGlobal(key, Reflect.get(testWindow, key === "window" ? "self" : key));
  }
  fixture.events = [];
  fixture.session = undefined;
  document.body.innerHTML = '<div id="root"></div>';
  history.replaceState(null, "", "/");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => fixture.unmount?.());
  fixture.unmount = null;
  await testWindow.happyDOM.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const start = async () => { await act(async () => { await import("./main"); }); };
const retry = async () => { await act(async () => { document.querySelector("button")!.click(); }); };

describe("web bootstrap", () => {
  it("mounts before requests, bounds a never-resolving session, and retries successfully", async () => {
    let signal: AbortSignal | undefined;
    const body = { kind: "session", id: "s", scopes: ["client"], hosted: true, cloudHome: true };
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit): Promise<Response> => {
      fixture.events.push("session");
      signal = init?.signal ?? undefined;
      return new Promise(() => {});
    });
    vi.stubGlobal("fetch", fetchImpl);
    await start();
    expect(fixture.events[0]).toBe("mount");
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Opening the app…");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(signal?.aborted).toBe(true);
    expect(document.querySelector("button")?.textContent).toBe("Retry");
    fetchImpl.mockResolvedValue(new Response(JSON.stringify(body)));
    await retry();
    expect(document.body.textContent).toContain("Chat app");
    expect(fixture.session).toEqual(body);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ kind: "loopback" }, "Chat app"],
    [{ kind: "loopback", trust: "service" }, "Sign in or pair this browser"],
  ])("keeps the successful auth routing for %j", async (body, text) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    await start();
    expect(document.body.textContent).toContain(text);
  });

  it("routes a refused session to pairing and gives network failures Retry", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchImpl);
    await start();
    expect(document.querySelector("button")?.textContent).toBe("Retry");
    fetchImpl.mockResolvedValue(new Response(JSON.stringify({ error: "session revoked" }), { status: 403 }));
    await retry();
    expect(document.body.textContent).toContain("Pair browser: session revoked");
  });

  it("bounds the sign-in preview and preserves its secret for Retry after removing it from history", async () => {
    const credential = `omb_pair_${"b".repeat(43)}`;
    history.replaceState(null, "", `/pair#signin=${credential}`);
    const fetchImpl = vi.fn().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchImpl);
    await start();
    expect(location.hash).toBe("");
    expect(document.body.textContent).toContain("Opening the app…");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(document.querySelector("button")?.textContent).toBe("Retry");
    fetchImpl.mockResolvedValue(new Response(JSON.stringify({ owner: "owner@example.com" })));
    await retry();
    expect(document.body.textContent).toContain("Continue as owner@example.com");
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toMatchObject({ code: credential, preview: true });
  });
});

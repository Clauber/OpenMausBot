import { describe, expect, it, vi } from "vitest";
import { createBrowserInputQueue } from "./browser-input-queue";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const move = (x: number) => ({ type: "input_mouse", eventType: "mouseMoved", x, y: 10 });
const wheel = (deltaY: number) => ({ type: "input_mouse", eventType: "mouseWheel", x: 10, y: 10, deltaY });
const key = (eventType: string, value = "a") => ({ type: "input_keyboard", eventType, key: value });
const up = { type: "input_mouse", eventType: "mouseReleased", button: "left" };

describe("bounded browser input queue", () => {
  it("coalesces adjacent movement and scroll without crossing keyboard/button boundaries", async () => {
    const first = deferred();
    const send = vi.fn<(body: Record<string, unknown>) => Promise<void>>().mockResolvedValue();
    send.mockImplementationOnce(() => first.promise);
    const queue = createBrowserInputQueue(send, vi.fn());
    queue.enqueue(key("keyDown"));
    queue.enqueue(move(1)); queue.enqueue(move(2)); queue.enqueue(move(3));
    queue.enqueue(key("keyUp"));
    queue.enqueue(wheel(10)); queue.enqueue(wheel(20));
    queue.enqueue(up);
    expect(send).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(5));
    expect(send.mock.calls.map(([body]) => body)).toEqual([
      key("keyDown"), move(3), key("keyUp"), { ...wheel(30), deltaX: 0 }, up,
    ]);
    await queue.drain();
  });

  it("drains key/button releases but discards queued movement on hand-back", async () => {
    const first = deferred();
    const send = vi.fn<(body: Record<string, unknown>) => Promise<void>>().mockResolvedValue();
    send.mockImplementationOnce(() => first.promise);
    const queue = createBrowserInputQueue(send, vi.fn());
    queue.enqueue(key("keyDown")); queue.enqueue(move(12)); queue.enqueue(wheel(100));
    queue.enqueue(key("keyUp")); queue.enqueue(up);
    let drained = false;
    const finished = queue.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    first.resolve(); await finished;
    expect(send.mock.calls.map(([body]) => body)).toEqual([key("keyDown"), key("keyUp"), up]);
  });

  it("counts unsent input and settles without discarding movement", async () => {
    const first = deferred();
    const send = vi.fn<(body: Record<string, unknown>) => Promise<void>>().mockResolvedValue();
    send.mockImplementationOnce(() => first.promise);
    const queue = createBrowserInputQueue(send, vi.fn());
    expect(queue.size()).toBe(0);
    queue.enqueue(key("keyDown")); queue.enqueue(move(1)); queue.enqueue(key("keyUp"));
    expect(queue.size()).toBe(3);
    const settled = queue.settle();
    first.resolve(); await settled;
    expect(send.mock.calls.map(([body]) => body)).toEqual([key("keyDown"), move(1), key("keyUp")]);
    expect(queue.size()).toBe(0);
  });

  it("invalidates old unsent input and ignores old errors after reconnect", async () => {
    let fail!: (cause: Error) => void;
    const first = new Promise<void>((_, reject) => { fail = reject; });
    const send = vi.fn<(body: Record<string, unknown>) => Promise<void>>().mockResolvedValue();
    send.mockImplementationOnce(() => first);
    const onError = vi.fn();
    const queue = createBrowserInputQueue(send, onError);
    queue.enqueue(key("keyDown", "old")); queue.enqueue(key("keyUp", "old"));
    queue.clear(); queue.enqueue(key("keyDown", "new"));
    fail(new Error("old viewer closed")); await queue.drain();
    expect(send.mock.calls.map(([body]) => body.key)).toEqual(["old", "new"]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("halts overflowing presses while retaining pending and later releases", async () => {
    const first = deferred();
    const send = vi.fn<(body: Record<string, unknown>) => Promise<void>>().mockResolvedValue();
    send.mockImplementationOnce(() => first.promise);
    const onError = vi.fn();
    const queue = createBrowserInputQueue(send, onError);
    queue.enqueue(key("keyDown", "held")); queue.enqueue(key("keyUp", "held"));
    for (let n = 0; n < 40; n++) queue.enqueue(key("keyDown", String(n)));
    queue.enqueue(up);
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: expect.stringContaining("Reconnect the view before typing again") }));
    // A hung engine fills the queue too; the message must not blame only the network.
    expect(onError.mock.calls[0][0].message).not.toMatch(/connection is too slow\./);
    expect(onError.mock.calls[0][0].message).toContain("restart the browser");
    first.resolve(); await queue.drain();
    expect(send.mock.calls.map(([body]) => body)).toEqual([key("keyDown", "held"), key("keyUp", "held"), up]);
    queue.clear(); queue.enqueue(key("keyDown", "after reconnect")); await queue.drain();
    expect(send).toHaveBeenLastCalledWith(key("keyDown", "after reconnect"));
  });

  it("sends every input queued behind a request in the next one where the server takes batches, and commands alone", async () => {
    const first = deferred();
    const send = vi.fn<(body: Record<string, unknown>) => Promise<void>>().mockResolvedValue();
    send.mockImplementationOnce(() => first.promise);
    const queue = createBrowserInputQueue(send, vi.fn(), 64);
    queue.enqueue(key("keyDown", "a"));
    queue.enqueue(key("keyUp", "a")); queue.enqueue(key("keyDown", "b")); queue.enqueue(move(1)); queue.enqueue(move(2)); queue.enqueue(key("keyUp", "b"));
    queue.enqueue({ type: "reload" });
    queue.enqueue(key("keyDown", "c"));
    first.resolve(); await queue.settle();
    expect(send.mock.calls.map(([body]) => body)).toEqual([
      key("keyDown", "a"),
      { type: "input_batch", events: [key("keyUp", "a"), key("keyDown", "b"), move(2), key("keyUp", "b")] },
      { type: "reload" },
      key("keyDown", "c"),
    ]);
  });

  it("keeps a batch to the limit the server gave and under the size it reads", async () => {
    const send = vi.fn<(body: Record<string, unknown>) => Promise<void>>().mockResolvedValue();
    for (const [limit, inputs] of [[3, Array.from({ length: 6 }, (_, n) => key("keyDown", String(n)))], [64, Array.from({ length: 10 }, () => ({ type: "input_keyboard", eventType: "char", text: "x".repeat(4_000) }))]] as const) {
      send.mockClear();
      const first = deferred();
      send.mockImplementationOnce(() => first.promise);
      const queue = createBrowserInputQueue(send, vi.fn(), limit);
      queue.enqueue(key("keyDown", "first"));
      for (const input of inputs) queue.enqueue(input);
      first.resolve(); await queue.settle();
      const sizes = send.mock.calls.slice(1).map(([body]) => (body.events as unknown[] | undefined)?.length ?? 1);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(limit);
      expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(inputs.length);
      expect(Math.max(...send.mock.calls.map(([body]) => JSON.stringify(body).length))).toBeLessThan(32_768);
    }
  });

  it("still sends the releases of a batch that failed, so nothing stays held, and no presses", async () => {
    const onError = vi.fn();
    const send = vi.fn<(body: Record<string, unknown>) => Promise<void>>().mockResolvedValue();
    const first = deferred();
    send.mockImplementationOnce(() => first.promise).mockRejectedValueOnce(new Error("could not confirm"));
    const queue = createBrowserInputQueue(send, onError, 64);
    queue.enqueue(key("keyDown", "a"));
    queue.enqueue(key("keyDown", "shift")); queue.enqueue(key("keyDown", "b")); queue.enqueue(key("keyUp", "b")); queue.enqueue(up); queue.enqueue(key("keyUp", "shift"));
    first.resolve(); await queue.settle();
    expect(send.mock.calls.slice(2).map(([body]) => body)).toEqual([key("keyUp", "b"), up, key("keyUp", "shift")]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("does not replay queued presses after a transport failure", async () => {
    const onError = vi.fn();
    const send = vi.fn<(body: Record<string, unknown>) => Promise<void>>().mockRejectedValueOnce(new Error("uncertain input")).mockResolvedValue();
    const queue = createBrowserInputQueue(send, onError);
    queue.enqueue(key("keyDown")); queue.enqueue(key("keyDown", "b")); queue.enqueue(key("keyUp"));
    await queue.drain();
    expect(send.mock.calls.map(([body]) => body)).toEqual([key("keyDown"), key("keyUp")]);
    expect(onError).toHaveBeenCalledOnce();
  });
});

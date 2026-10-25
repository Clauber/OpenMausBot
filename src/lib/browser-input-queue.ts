import { t } from "@/lib/i18n";

type Input = Record<string, unknown>;
const movement = (body: Input) => body.type === "input_mouse" && ["mouseMoved", "mouseWheel"].includes(String(body.eventType));
const release = (body: Input) => (body.type === "input_mouse" && body.eventType === "mouseReleased") || (body.type === "input_keyboard" && body.eventType === "keyUp");
const delta = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
const clamp = (value: number) => Math.max(-10_000, Math.min(10_000, value));
const batchable = (body: Input) => body.type === "input_mouse" || body.type === "input_keyboard";
/** Under the 32 KB the server reads of one action's body. */
const BATCH_BYTES = 24_000;

/** One request at a time, with replaceable movement coalesced behind it.
 * Keyboard/button order is preserved; reconnect never replays old input. Where the server takes batches
 * (`batchLimit` above 1), every input queued behind a request goes in the next one. */
export function createBrowserInputQueue(send: (body: Input) => Promise<void>, onError: (cause: unknown) => void, batchLimit = 1) {
  let queue: Input[] = [];
  let active: Promise<void> | null = null;
  let generation = 0;
  let stopped = false;
  const halt = (cause: unknown) => {
    queue = queue.filter(release);
    if (!stopped) { stopped = true; onError(cause); }
  };
  const next = (): Input[] => {
    const taken = [queue.shift()!];
    const limit = stopped ? 1 : batchLimit;
    let bytes = JSON.stringify(taken[0]).length;
    while (batchable(taken[0]!) && taken.length < limit && queue.length && batchable(queue[0]!)) {
      const size = JSON.stringify(queue[0]).length;
      if (bytes + size > BATCH_BYTES) break;
      bytes += size;
      taken.push(queue.shift()!);
    }
    return taken;
  };
  const run = () => {
    if (active || !queue.length) return;
    const current = generation;
    active = (async () => {
      while (current === generation && queue.length) {
        const taken = next();
        try { await send(taken.length === 1 ? taken[0]! : { type: "input_batch", events: taken }); }
        catch (cause) {
          if (current !== generation) continue;
          // The server stops a batch at its first failure, so its later releases may never have been sent.
          if (taken.length > 1) queue.unshift(...taken.slice(1).filter(release));
          halt(cause);
        }
      }
    })().finally(() => { active = null; run(); });
  };
  return {
    enqueue(body: Input) {
      if (stopped && !release(body)) return;
      const last = queue.at(-1);
      if (last && movement(body) && last.type === body.type && last.eventType === body.eventType && last.modifiers === body.modifiers && last.button === body.button) {
        queue[queue.length - 1] = body.eventType === "mouseWheel"
          ? { ...body, deltaX: clamp(delta(last.deltaX) + delta(body.deltaX)), deltaY: clamp(delta(last.deltaY) + delta(body.deltaY)) }
          : { ...body };
        return;
      }
      // ponytail: fixed 32-item ceiling; do not let a slow VPS accumulate
      // minutes of input. Overload halts new presses until the view reconnects.
      if (queue.length >= 32) {
        if (movement(body)) return;
        const replaceable = queue.findIndex(movement);
        if (replaceable >= 0) queue.splice(replaceable, 1);
        else {
          halt(new Error(t("browser.input.tooSlow")));
          if (!release(body) || queue.length >= 32) return;
        }
      }
      queue.push({ ...body });
      run();
    },
    async drain() {
      // Hand-back waits for keys/buttons, not stale cursor/scroll movement.
      queue = queue.filter((body) => !movement(body));
      while (active || queue.length) { run(); await active; }
    },
    /** Waits until everything queued, movement included, has been sent. */
    async settle() { while (active || queue.length) { run(); await active; } },
    /** Inputs not yet confirmed: queued plus the one in flight. */
    size() { return queue.length + (active ? 1 : 0); },
    clear() { generation++; queue = []; stopped = false; },
    /** Halted queues drop input silently; callers keep the halt banner up. */
    stopped() { return stopped; },
  };
}

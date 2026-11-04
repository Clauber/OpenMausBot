// The capture set the council asked for: the states a static desktop shot cannot show.
// Run against a live fixture URL. Every file lands in the output directory.
//   node --experimental-strip-types scripts/testing/chat-ui-capture.mjs <url> <outDir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openHeadlessChrome } from "./headless-chrome.ts";

const url = process.argv[2];
const out = process.argv[3] ?? "/tmp/omb-chat-capture";
mkdirSync(out, { recursive: true });

const page = await openHeadlessChrome(join(out, "profile"));
const evaluate = async (expression) => {
  const result = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shot = async (name) => {
  writeFileSync(join(out, `${name}.png`), await page.capture());
  console.log(`shot ${name}`);
};
const metrics = (width, height, mobile = false) =>
  page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
const key = async (value, code, modifiers = 0) => {
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: value, windowsVirtualKeyCode: code, modifiers });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: value, windowsVirtualKeyCode: code, modifiers });
};
const dismiss = async () => {
  await evaluate(`(() => {
    for (const node of document.querySelectorAll('button')) {
      const text = (node.textContent || '').trim();
      if (/^(Not now|Dismiss|Close)$/i.test(text)) node.click();
    }
    document.activeElement?.blur?.();
  })()`);
  await wait(700);
};
const toBottom = async () => {
  await evaluate(`(() => {
    const scroller = [...document.querySelectorAll('*')]
      .filter((n) => n.scrollHeight > n.clientHeight + 80 && getComputedStyle(n).overflowY !== 'visible')
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  })()`);
  await wait(600);
};

const report = {};

// Desktop, keyboard focus on the composer.
await metrics(1440, 950);
await page.send("Page.navigate", { url });
await page.until(`document.querySelector('textarea')`);
await wait(3000);
await dismiss();
await toBottom();
await shot("desktop-chat");

// A keypress first, so Chrome's focus-visible heuristic treats the focus as keyboard-driven,
// then focus the composer. That is the state a keyboard user is in.
await key("Shift", 16);
await evaluate(`document.querySelector('textarea')?.focus()`);
await wait(400);
report.composerFocus = await evaluate(`(() => {
  const area = document.querySelector('textarea');
  const shell = area?.closest('[data-tour="composer"]');
  return { focusVisible: area?.matches(':focus-visible') ?? false, ring: shell ? getComputedStyle(shell).boxShadow : null };
})()`);
await shot("desktop-composer-focus");

// Phone, with the software keyboard taking the lower half.
await metrics(390, 844, true);
await wait(1200);
await toBottom();
await shot("phone-chat");

// Phone, keyboard open: the viewport shrinks, which is the layout that was never checked.
await metrics(390, 420, true);
await wait(1200);
await toBottom();
await shot("phone-keyboard-open");

// Landscape phone.
await metrics(844, 390, true);
await wait(1200);
await toBottom();
await shot("phone-landscape");

// The lightbox on a phone.
await metrics(390, 844, true);
await wait(1000);
await evaluate(`(() => {
  const node = document.querySelector('[role="button"][aria-label^="Preview attached image"]');
  if (!node) return false;
  node.scrollIntoView({ block: 'center' });
  node.click();
  return true;
})()`);
await wait(1600);
await shot("phone-lightbox");

writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report));
await page.close();

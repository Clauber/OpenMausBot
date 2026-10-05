import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "./control-omb-ui.ts";

export async function verifyTaughtSkillsUi(url: string, evidenceDir: string, failClick: (value: boolean) => void) {
  const home = mkdtempSync(join(tmpdir(), "lt11-")); mkdirSync(join(home, "tmp"));
  const { binary, chrome } = await ensureUiBrowser();
  const env = sessionEnv({ home, chrome, session: "teach11" });
  const browser = (args: string[]) => agentBrowser(binary, env, args);
  const evaluate = (js: string) => browser(["eval", js]);
  const wait = (js: string) => browser(["wait", "--fn", js]);
  const click = (label: string) => evaluate(`(() => {const button=[...document.querySelectorAll('button')].find(item=>item.textContent.trim()===${JSON.stringify(label)} && !item.disabled);if(!button) throw new Error('Missing button: ${label}');button.click();return true;})()`);
  const fill = (label: string, value: string) => evaluate(`(() => {const field=document.querySelector('[aria-label=${JSON.stringify(label)}]');if(!field)throw new Error('Missing field');const proto=field.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:field.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event(field.tagName==='SELECT'?'change':'input',{bubbles:true}));return true;})()`);
  await browser(["open", url]);
  await browser(["set", "viewport", "1600", "1000"]);
  await wait("[...document.querySelectorAll('button')].some(item=>item.textContent.trim()==='Computer')");
  await click("Computer");
  await wait("!!document.querySelector('[aria-label=\"Demonstration title\"]')");
  await fill("Playbook replay bot", new URL(url).searchParams.get("bot")!);
  console.log("Browser: recording from the actual Computer panel");
  await fill("Demonstration title", "Browser form demo");
  await fill("Narration notes", "Browser recorded demonstration");
  await click("Start recording");
  await wait("!!document.querySelector('[aria-label=\"Demonstration action\"]')");
  for (const [tool, field, value, count] of [["navigate", "url", "https://example.com/demo", 1], ["click", "selector", "#name", 2], ["type", "text", "Browser demo", 3]] as const) {
    await fill("Demonstration action", tool);
    await wait(`!!document.querySelector('[aria-label="Action ${field}"]')`);
    await fill(`Action ${field}`, value); await click("Perform action");
    await wait(`[...document.querySelectorAll('[role=status]')].some(item=>item.textContent.includes('· ${count} steps'))`);
  }
  await browser(["screenshot", join(evidenceDir, "recording.png")]);
  await click("Stop and save");
  await wait("[...document.querySelectorAll('div')].some(item=>item.textContent==='Browser form demo')");
  const replay = () => evaluate(`(() => {const title=[...document.querySelectorAll('div')].find(item=>item.textContent==='Browser form demo');const row=title.closest('.p-3');const button=[...row.querySelectorAll('button')].find(item=>item.textContent==='Replay');if(!button||button.disabled)throw new Error('Replay unavailable');button.click();return true;})()`);
  console.log("Browser: requesting replay and reviewing the approval card");
  await replay();
  await wait("[...document.querySelectorAll('button')].some(item=>item.textContent.trim()==='Enable' && !item.disabled)");
  await browser(["screenshot", join(evidenceDir, "approval.png")]);
  await click("Enable");
  await wait("document.querySelector('[aria-label=\"Run history for Browser form demo\"]')?.textContent.includes('success')");
  const first = await browser(["snapshot"]);
  assert.ok(JSON.stringify(first).includes("success"));
  // A second Replay uses the persisted approval, and the failing click stops the run.
  failClick(true); await replay();
  await wait("document.querySelector('[aria-label=\"Run history for Browser form demo\"]')?.textContent.includes('stopped at step 2 (index 1)')");
  failClick(false);
  const failed = await browser(["snapshot"]); assert.ok(JSON.stringify(failed).includes("element-not-found"));
  await browser(["screenshot", join(evidenceDir, "failed-run.png")]);
  await replay();
  await wait("document.querySelector('[aria-label=\"Run history for Browser form demo\"]')?.firstElementChild?.textContent.includes('success')");
  // Also exercise the always-ask setting through the real settings primitive.
  await evaluate("(() => {const label=[...document.querySelectorAll('label')].find(item=>item.textContent.includes('Always ask before replay'));label.querySelector('button').click();return true;})()");
  await wait("document.querySelector('button[role=switch]')?.getAttribute('aria-checked')==='true'");
  await evaluate("(() => {const label=[...document.querySelectorAll('label')].find(item=>item.textContent.includes('Always ask before replay'));label.querySelector('button').click();return true;})()");
  await wait("document.querySelector('button[role=switch]')?.getAttribute('aria-checked')==='false'");
  await browser(["screenshot", join(evidenceDir, "playbooks.png")]);
  await fill("Demonstration title", "Discard browser demo"); await click("Start recording");
  await wait("[...document.querySelectorAll('button')].some(item=>item.textContent==='Discard')");
  await click("Discard"); await wait("!!document.querySelector('[aria-label=\"Demonstration title\"]')");
  console.log("Browser: real Computer panel recording, Skills replay/history, approval card, failed step, always-ask and discard passed; teach11 tab parked.");
  return { url, session: "teach11", success: first, failed, screenshotDirectory: evidenceDir };
}

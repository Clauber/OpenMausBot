import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "./control-omb-ui.ts";

/** Real app and isolated HTTP fixture. Keep the browser parked for inspection;
 * the caller owns/stops both fixture servers after evidence is written. */
export async function verifyPagesUi(previewUrl: string, apiUrl: string, pageId: string, evidencePath: string, sourcePageId: string, reviewRequestId?: string) {
  // Chromium's own SingletonSocket adds a suffix below TMPDIR, so its
  // HOME must be short as well as agent-browser's session name.
  const home = mkdtempSync(join(tmpdir(), "lp7-"));
  mkdirSync(join(home, "tmp"), { recursive: true });
  const { binary, chrome } = await ensureUiBrowser();
  const env = sessionEnv({ home, chrome, session: "pg7" });
  const browser = (args: string[]) => agentBrowser(binary, env, args);
  const evaluate = (js: string) => browser(["eval", js]);
  const wait = (js: string) => browser(["wait", "--fn", js]);
  const evidence: unknown[] = [];
  const url = `${previewUrl}#/pages/${pageId}`;
  const markdownSelector = 'textarea[aria-label="Page markdown"]';
  const change = (value: string) => evaluate(`(() => {
    const field = document.querySelector(${JSON.stringify(markdownSelector)});
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event('input', {bubbles: true})); return true;
  })()`);
  const click = (text: string) => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!button || button.disabled) throw new Error('button unavailable'); button.click(); return true; })()`);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(apiUrl + path, { method, headers: { "content-type": "application/json", origin: apiUrl },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), });
    const result = await response.json() as any; assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  console.log("Pages browser: opening actual workspace");
  await agentBrowser(binary, env, ["open", url], 120_000);
  await wait(`!!document.querySelector(${JSON.stringify(markdownSelector)})`);
  evidence.push(await browser(["snapshot"]));
  const sections = await evaluate(`({pagesNav: !!document.querySelector('[data-sidebar-nav="pages"]'), editor: !!document.querySelector('[aria-label="Page editor"]'), preview: !!document.querySelector('[aria-label="Page preview"]')})`);
  assert.ok(JSON.stringify(sections).includes('"pagesNav":true')); evidence.push(sections);
  await change("# Browser autosave\n\nBROWSER_AUTOSAVE_7");
  await wait("[...document.querySelectorAll('[role=status]')].some(e => e.textContent.startsWith('Saved'))");
  let saved = (await api("GET", `/api/pages/${pageId}`)).page;
  assert.ok(saved.content.includes("BROWSER_AUTOSAVE_7")); evidence.push({ autosave: saved });
  // Concurrent server edit after this editor loaded: its revision is stale.
  saved = (await api("PATCH", `/api/pages/${pageId}`, { revision: saved.revision, content: "REMOTE_EDIT_7" })).page;
  await change("# Retained local draft\n\nBROWSER_LOCAL_DRAFT_7");
  await wait("[...document.querySelectorAll('[role=alert]')].some(e => e.textContent.includes('This page changed elsewhere'))");
  const conflictScreenshot = `${evidencePath}.conflict.png`;
  await browser(["screenshot", conflictScreenshot]);
  evidence.push({ conflict: await browser(["snapshot"]), conflictScreenshot });
  // Hard navigation proves draft retention and a conflict on reopening.
  await browser(["open", url]);
  await wait(`document.querySelector(${JSON.stringify(markdownSelector)})?.value.includes('BROWSER_LOCAL_DRAFT_7') && [...document.querySelectorAll('[role=alert]')].some(e => e.textContent.includes('This page changed elsewhere'))`);
  evidence.push({ restoredDraft: await evaluate(`({value:document.querySelector(${JSON.stringify(markdownSelector)}).value, draftKeys:Object.keys(localStorage).filter(k=>k.startsWith('legion-page-draft:'))})`) });
  await click("Overwrite latest with my draft");
  await wait("[...document.querySelectorAll('[role=status]')].some(e => e.textContent.startsWith('Saved'))");
  saved = (await api("GET", `/api/pages/${pageId}`)).page;
  assert.ok(saved.content.includes("BROWSER_LOCAL_DRAFT_7")); evidence.push({ overwrite: saved });
  console.log("Pages browser: autosave, 409 draft retention, reload and overwrite passed");
  await evaluate("(() => {const field=document.querySelector('select[aria-label=\"Page chat bot\"]'); field.value=[...field.options].find(o=>o.value).value;field.dispatchEvent(new Event('change',{bubbles:true})); return true})()");
  await click("Open page chat");
  await wait("!!document.querySelector('textarea[aria-label^=\"Message \"]')");
  evidence.push({ pageChatNavigation: await browser(["snapshot"]) });
  await evaluate(`location.hash='/pages/${sourcePageId}'; true`);
  await wait("[...document.querySelectorAll('button')].some(b=>b.textContent==='Open source conversation')");
  await click("Open source conversation");
  if (reviewRequestId) {
    await wait("[...document.querySelectorAll('button')].some(b=>b.textContent==='Save page' && !b.disabled)");
    evidence.push({ reviewBeforeSave: await browser(["snapshot"]) });
    await click("Save page");
    await wait("![...document.querySelectorAll('button')].some(b=>b.textContent==='Save page')");
    const approved = (await api("GET", "/api/pages")).pages.filter((page: any) => page.title === "Browser reviewed page");
    assert.equal(approved.length, 1);
    const duplicate = await api("POST", `/api/threads/${approved[0].sourceThreadId}/respond`, { requestId: reviewRequestId, behavior: "allow" });
    assert.equal(duplicate.pageId, approved[0].id);
    evidence.push({ reviewedThroughComposer: approved[0], duplicate });
    await browser(["screenshot", `${evidencePath}.approval.png`]);
    console.log("Pages browser: source backlink and existing Save page approval passed");
  }
  await evaluate(`location.hash='/pages/${pageId}'; true`);
  await wait(`!!document.querySelector(${JSON.stringify(markdownSelector)})`);
  // Create through the UI, then show the nested page in the actual tree.
  await click("New child page");
  await wait(`document.querySelector('input[aria-label="Page title"]')?.value === 'Untitled page'`);
  const tree = await api("GET", "/api/pages");
  assert.ok(tree.pages.some((page: any) => page.title === "Untitled page" && page.parentId === pageId));
  await evaluate(`location.hash='/pages/${pageId}'; true`);
  await wait(`document.querySelector(${JSON.stringify(markdownSelector)})?.value.includes('BROWSER_LOCAL_DRAFT_7')`);
  const screenshotPath = `${evidencePath}.workspace.png`;
  await browser(["screenshot", screenshotPath]);
  evidence.push({ finalSnapshot: await browser(["snapshot"]), screenshotPath });
  const consoleOutput = await browser(["console"]);
  evidence.push({ consoleOutput });
  const messages = (consoleOutput.messages ?? []) as Array<{ type?: string }>;
  assert.ok(!messages.some((message) => message.type === "error"), JSON.stringify(consoleOutput));
  writeFileSync(`${evidencePath}.ui.json`, JSON.stringify(evidence, null, 2));
  return { screenshotPath, conflictScreenshot, browserSession: env.AGENT_BROWSER_SESSION, browserHome: home, parkedUrl: url, uiEvidencePath: `${evidencePath}.ui.json` };
}

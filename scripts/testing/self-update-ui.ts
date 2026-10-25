import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import baseConfig from "../../vite.config.ts";
import { launchVerificationServer } from "../control-omb.ts";
import { createSelfUpdateFixture } from "../../server/testing/self-update-fixture.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "./control-omb-ui.ts";

export async function verifySelfUpdateUi() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const evidenceDir = join(root, ".omb-scratch/self-update-evidence");
  await mkdir(evidenceDir, { recursive: true });
  const home = await mkdtemp(join(tmpdir(), "legion-update-ui-"));
  await mkdir(join(home, "tmp"));
  const fixture = await createSelfUpdateFixture();
  let production: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  const http = createHttpServer();
  let browser: ((args: string[]) => Promise<unknown>) | undefined;
  try {
    production = await launchVerificationServer({});
    vite = await createServer({ ...baseConfig, configFile: false, root, cacheDir: join(root, ".omb-scratch/self-update-vite"), server: { middlewareMode: { server: http }, hmr: { server: http }, proxy: { "/api/updater": { target: fixture.apiUrl }, "/api": { target: production.info.url } } }, plugins: [...(baseConfig.plugins ?? []), { name: "self-update-preview", configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/__self-update.html") return next();
        void server.transformIndexHtml(req.url, '<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Legion · Software Update fixture</title></head><body><div id="root"></div><script type="module" src="/scripts/testing/self-update-preview.tsx"></script></body></html>')
          .then(html => { res.setHeader("content-type", "text/html"); res.end(html); }).catch(next);
      });
    } }] });
    http.on("request", vite.middlewares);
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    const preview = `http://127.0.0.1:${(http.address() as { port: number }).port}/__self-update.html`;
    const tools = await ensureUiBrowser(process.env, () => {}, join(root, ".omb-scratch/verify-tools"));
    const env = sessionEnv({ home, chrome: tools.chrome, session: `up${process.pid}` });
    browser = (args: string[]) => agentBrowser(tools.binary, env, args, 60_000);
    const evaluate = (js: string) => browser!(["eval", js]);
    const wait = (js: string) => browser!(["wait", "--fn", js]);
    const click = (text: string) => evaluate(`(() => {const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw new Error('Button unavailable: '+${JSON.stringify(text)});b.click();return true})()`);
    const text = (value: string) => `document.body.innerText.includes(${JSON.stringify(value)})`;
    await browser(["open", preview]);
    const showUpdate = () => evaluate(`(() => {const title=[...document.querySelectorAll("div")].find(e=>e.children.length===0 && e.textContent==="Software Update");title?.parentElement.scrollIntoView({block:"start"});return true})()`);
    await wait(text("Version 1.0.0"));
    await click("Check for updates");
    await wait(text("1.0.0 → 2.0.0"));
    await click("Apply update");
    await wait("!!document.querySelector('[role=alertdialog][aria-label=\"Confirm software update\"]')");
    await showUpdate();
    await browser(["screenshot", join(evidenceDir, "confirm.png")]);
    await click("Cancel");
    await wait("!document.querySelector('[role=alertdialog][aria-label=\"Confirm software update\"]')");
    assert.equal(fixture.updater.state().enabled && (fixture.updater.state() as { current: string }).current, "1.0.0");
    await click("Apply update");
    await click("Install and restart");
    await wait(text("Updating:"));
    await wait(text("Updated to 2.0.0. Health check passed."));
    assert.equal((await fixture.waitForResult()).current, "2.0.0");
    await showUpdate();
    await browser(["screenshot", join(evidenceDir, "applied.png")]);
    fixture.setReleases(["1.0.0", "2.0.0", "3.0.0"]);
    await click("Check for updates");
    await wait(text("2.0.0 → 3.0.0"));
    await click("Apply update"); await click("Install and restart");
    await wait(text("Updating:"));
    await wait(text("Update rolled back automatically to 2.0.0."));
    assert.equal((await fixture.waitForResult()).lastApply?.status, "rolled-back");
    await showUpdate();
    await browser(["screenshot", join(evidenceDir, "rollback.png")]);
    const snapshot = await browser(["snapshot"]);
    const consoleErrors = await browser(["errors"]);
    const result = { preview, surface: "Settings / General / Software Update", versions: "1.0.0 -> 2.0.0; broken 3.0.0 -> rollback 2.0.0", snapshot, consoleErrors, screenshots: ["confirm.png", "applied.png", "rollback.png"].map(file => join(evidenceDir, file)) };
    await writeFile(join(evidenceDir, "browser.json"), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    if (browser) {
      const diagnostic = { snapshot: await browser(["snapshot"]), errors: await browser(["errors"]) };
      await writeFile(join(evidenceDir, "failure.json"), JSON.stringify(diagnostic, null, 2));
      await browser(["screenshot", join(evidenceDir, "failure.png")]);
    }
    throw error;
  } finally {
    // Ticket explicitly requires killing everything; no browser or fixture is retained.
    await browser?.(["close"]).catch(() => {});
    await production?.close();
    if (production) await rm(production.info.logPath, { force: true });
    await fixture.close();
    await vite?.close();
    await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); });
    await rm(home, { recursive: true, force: true });
  }
}

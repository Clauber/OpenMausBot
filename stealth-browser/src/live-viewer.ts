import type { Express } from "express";
import type { Request, Response } from "express";
import type { Server } from "http";
import type { CDPSession, Page } from "patchright";
import { WebSocketServer, WebSocket } from "ws";
import type { RouteMode } from "./types";
import { PORT } from "./types";
import { getOrCreatePersistentContext, persistentSessions } from "./browser";

// Live Viewer HTML — CDP Screencast + Input relay via WebSocket
export const LIVE_VIEWER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Live Browser — {AGENT}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; flex-direction: column; height: 100vh; }
  #tabs { background: #0d1b2a; display: flex; overflow-x: auto; border-bottom: 1px solid #1b2838; min-height: 32px; }
  .tab { padding: 6px 14px; font-size: 12px; color: #8899aa; cursor: pointer; white-space: nowrap; border-right: 1px solid #1b2838; max-width: 200px; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px; }
  .tab:hover { background: #16213e; color: #ccc; }
  .tab.active { background: #16213e; color: #e94560; border-bottom: 2px solid #e94560; }
  .tab .close-tab { font-size: 14px; color: #555; cursor: pointer; margin-left: 4px; }
  .tab .close-tab:hover { color: #e94560; }
  #toolbar { background: #16213e; padding: 8px 16px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #0f3460; }
  #toolbar h1 { font-size: 14px; font-weight: 600; color: #e94560; }
  #url-bar { flex: 1; background: #0f3460; border: 1px solid #533483; border-radius: 4px; padding: 6px 12px; color: #e0e0e0; font-size: 13px; }
  #url-bar:focus { outline: none; border-color: #e94560; }
  .toolbar-btn { background: #0f3460; border: 1px solid #533483; border-radius: 4px; padding: 4px 10px; color: #aaa; cursor: pointer; font-size: 16px; }
  .toolbar-btn:hover { background: #533483; color: #fff; }
  #status { font-size: 11px; padding: 4px 8px; border-radius: 3px; }
  .connected { background: #1b4332; color: #52b788; }
  .disconnected { background: #5c1a1a; color: #ff6b6b; }
  #viewer { flex: 1; display: flex; justify-content: center; align-items: flex-start; overflow: auto; background: #111; position: relative; padding: 0; }
  #screen { cursor: default; image-rendering: auto; display: block; }
  #info { background: #16213e; padding: 4px 16px; font-size: 11px; color: #888; display: flex; gap: 16px; border-top: 1px solid #0f3460; }
</style>
</head>
<body>
<div id="tabs"></div>
<div id="toolbar">
  <h1>\\u{1F534} {AGENT}</h1>
  <button class="toolbar-btn" id="new-tab" title="New tab">+</button>
  <input id="url-bar" type="text" placeholder="URL" />
  <span id="status" class="disconnected">Connecting...</span>
</div>
<div id="viewer"><img id="screen" alt="Browser" draggable="false" /></div>
<div id="info">
  <span id="fps">FPS: \\u{2014}</span>
  <span id="resolution">\\u{2014}</span>
  <span>Click, type, and scroll to control the browser</span>
</div>
<script>
const agent = '{AGENT}', route = '{ROUTE}';
const screen = document.getElementById('screen'), urlBar = document.getElementById('url-bar');
const statusEl = document.getElementById('status'), fpsEl = document.getElementById('fps');
const resEl = document.getElementById('resolution'), tabsEl = document.getElementById('tabs');
let ws, frameCount = 0, lastFpsTime = Date.now(), currentTabId = null, allTabs = [];
let deviceW = 1280, deviceH = 960;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/live/ws/' + agent + '?route=' + route);
  ws.onopen = () => { statusEl.textContent = 'Connected'; statusEl.className = 'connected'; };
  ws.onclose = () => { statusEl.textContent = 'Disconnected'; statusEl.className = 'disconnected'; setTimeout(connect, 2000); };
  ws.onerror = () => ws.close();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'frame') { screen.src = 'data:image/jpeg;base64,' + msg.data; frameCount++; if (msg.width) deviceW = msg.width; if (msg.height) deviceH = msg.height; const now = Date.now(); if (now - lastFpsTime >= 1000) { fpsEl.textContent = 'FPS: ' + frameCount; frameCount = 0; lastFpsTime = now; } if (msg.width && msg.height) resEl.textContent = msg.width + 'x' + msg.height; }
    else if (msg.type === 'url') { urlBar.value = msg.url; }
    else if (msg.type === 'tabs') { allTabs = msg.tabs; currentTabId = msg.activeId; renderTabs(); }
  };
}
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function coords(e) { const r = screen.getBoundingClientRect(); return { x: Math.round((e.clientX - r.left) * (deviceW / r.width)), y: Math.round((e.clientY - r.top) * (deviceH / r.height)) }; }
function btn(e) { return e.button === 0 ? 'left' : e.button === 1 ? 'middle' : e.button === 2 ? 'right' : 'none'; }
screen.addEventListener('mousemove', (e) => { const c = coords(e); send({ type: 'mouse', action: 'mouseMoved', ...c, button: 'none', clickCount: 0 }); });
screen.addEventListener('mousedown', (e) => { e.preventDefault(); const c = coords(e); send({ type: 'mouse', action: 'mousePressed', ...c, button: btn(e), buttons: e.buttons, clickCount: 1 }); });
screen.addEventListener('mouseup', (e) => { e.preventDefault(); const c = coords(e); send({ type: 'mouse', action: 'mouseReleased', ...c, button: btn(e), buttons: e.buttons, clickCount: 1 }); });
screen.addEventListener('wheel', (e) => { e.preventDefault(); const c = coords(e); send({ type: 'scroll', ...c, deltaX: e.deltaX, deltaY: e.deltaY }); }, { passive: false });
screen.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('paste', (e) => { if (e.target === urlBar) return; e.preventDefault(); const text = e.clipboardData?.getData('text'); if (text) send({ type: 'paste', text }); });
document.addEventListener('keydown', (e) => { if (e.target === urlBar) { if (e.key === 'Enter') { send({ type: 'navigate', url: urlBar.value }); urlBar.blur(); } return; } if ((e.metaKey || e.ctrlKey) && e.key === 'v') return; e.preventDefault(); send({ type: 'key', action: 'keyDown', key: e.key, code: e.code, text: e.key.length === 1 ? e.key : '', modifiers: (e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0) }); });
document.addEventListener('keyup', (e) => { if (e.target === urlBar) return; if ((e.metaKey || e.ctrlKey) && e.key === 'v') return; e.preventDefault(); send({ type: 'key', action: 'keyUp', key: e.key, code: e.code, modifiers: (e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0) }); });
function renderTabs() { tabsEl.innerHTML = ''; allTabs.forEach(t => { const div = document.createElement('div'); div.className = 'tab' + (t.id === currentTabId ? ' active' : ''); const title = t.title || t.url?.substring(0, 30) || 'New Tab'; div.innerHTML = '<span>' + title.substring(0, 30) + '</span><span class="close-tab">\\u{00D7}</span>'; div.querySelector('span').addEventListener('click', () => send({ type: 'switchTab', tabId: t.id })); div.querySelector('.close-tab').addEventListener('click', (e) => { e.stopPropagation(); send({ type: 'closeTab', tabId: t.id }); }); tabsEl.appendChild(div); }); }
document.getElementById('new-tab').addEventListener('click', () => send({ type: 'newTab', url: 'about:blank' }));
connect();
</script>
</body>
</html>`;

function keyToVirtualKeyCode(key: string): number {
  const map: Record<string, number> = {
    Backspace: 8,
    Tab: 9,
    Enter: 13,
    Shift: 16,
    Control: 17,
    Alt: 18,
    Escape: 27,
    " ": 32,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Delete: 46,
    "0": 48,
    "1": 49,
    "2": 50,
    "3": 51,
    "4": 52,
    "5": 53,
    "6": 54,
    "7": 55,
    "8": 56,
    "9": 57,
    a: 65,
    b: 66,
    c: 67,
    d: 68,
    e: 69,
    f: 70,
    g: 71,
    h: 72,
    i: 73,
    j: 74,
    k: 75,
    l: 76,
    m: 77,
    n: 78,
    o: 79,
    p: 80,
    q: 81,
    r: 82,
    s: 83,
    t: 84,
    u: 85,
    v: 86,
    w: 87,
    x: 88,
    y: 89,
    z: 90,
    F1: 112,
    F2: 113,
    F3: 114,
    F4: 115,
    F5: 116,
    F6: 117,
    F7: 118,
    F8: 119,
    F9: 120,
    F10: 121,
    F11: 122,
    F12: 123,
  };
  if (key.length === 1) {
    const u = key.toUpperCase();
    if (u >= "A" && u <= "Z") return u.charCodeAt(0);
  }
  return map[key] || 0;
}

async function startScreencast(ws: WebSocket, cdp: CDPSession, page: Page) {
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 80,
    maxWidth: 1280,
    maxHeight: 960,
    everyNthFrame: 1,
  });
  cdp.on("Page.screencastFrame", (params: any) => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(
        JSON.stringify({
          type: "frame",
          data: params.data,
          width: params.metadata?.deviceWidth,
          height: params.metadata?.deviceHeight,
        }),
      );
    cdp
      .send("Page.screencastFrameAck", { sessionId: params.sessionId })
      .catch(() => {});
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: "url", url: frame.url() }));
  });
}

export function registerLiveViewer(app: Express, httpServer: Server): void {
  app.get("/live/:agent", (req: Request, res: Response) => {
    const agent = String(req.params.agent);
    const route = String(req.query.route || "residential");
    const html = LIVE_VIEWER_HTML.replace(/{AGENT}/g, agent).replace(
      /{ROUTE}/g,
      route,
    );
    res.type("html").send(html);
  });

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "", `http://localhost:${PORT}`);
    const match = url.pathname.match(/^\/live\/ws\/([^/]+)$/);
    if (!match) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit(
        "connection",
        ws,
        req,
        match[1],
        url.searchParams.get("route") || "residential",
      );
    });
  });

  wss.on(
    "connection",
    async (ws: WebSocket, _req: any, agent: string, route: string) => {
      console.log(
        `[live-viewer] Client connected for agent "${agent}" (route: ${route})`,
      );
      let cdp: CDPSession | null = null;
      let page: Page | null = null;
      try {
        const ctx = await getOrCreatePersistentContext(
          agent,
          route as RouteMode,
        );
        const pages = ctx.pages();
        page = pages.length > 0 ? pages[0] : await ctx.newPage();
        if (!page.url() || page.url() === "about:blank")
          await page
            .goto("https://www.google.com", {
              waitUntil: "domcontentloaded",
              timeout: 15000,
            })
            .catch(() => {});
        ws.send(JSON.stringify({ type: "url", url: page.url() }));

        ctx.on("page", async (newPage) => {
          await newPage.waitForLoadState("domcontentloaded").catch(() => {});
          if (cdp) {
            await cdp.send("Page.stopScreencast").catch(() => {});
            await cdp.detach().catch(() => {});
          }
          page = newPage;
          cdp = await page.context().newCDPSession(page);
          await startScreencast(ws, cdp, page);
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "url", url: page.url() }));
          await sendTabList();
        });

        async function sendTabList() {
          try {
            const debugPort =
              persistentSessions.get(agent + ":" + route)?.debugPort || 9500;
            const resp = await fetch("http://127.0.0.1:" + debugPort + "/json");
            const targets = (await resp.json()) as any[];
            const pageTabs = targets.filter(
              (t: any) =>
                t.type === "page" && !t.url?.startsWith("devtools://"),
            );
            const tabList = pageTabs.map((t: any) => ({
              id: t.id,
              title: t.title || t.url?.split("/")[2] || "New Tab",
              url: t.url,
            }));
            const activeId = page
              ? pageTabs.find((t: any) => t.url === page!.url())?.id ||
                pageTabs[0]?.id
              : null;
            ws.send(JSON.stringify({ type: "tabs", tabs: tabList, activeId }));
          } catch {}
        }
        await sendTabList();

        cdp = await page.context().newCDPSession(page);
        await startScreencast(ws, cdp, page);

        ws.on("message", async (raw: Buffer) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (!cdp || !page) return;
            switch (msg.type) {
              case "mouse":
                await cdp.send("Input.dispatchMouseEvent", {
                  type: msg.action,
                  x: msg.x,
                  y: msg.y,
                  button:
                    msg.action === "mouseMoved" ? "none" : msg.button || "left",
                  buttons:
                    msg.buttons ?? (msg.action === "mousePressed" ? 1 : 0),
                  clickCount: msg.clickCount || 0,
                  modifiers: msg.modifiers || 0,
                });
                break;
              case "key":
                await cdp.send("Input.dispatchKeyEvent", {
                  type: msg.action,
                  key: msg.key,
                  code: msg.code,
                  text: msg.action === "keyDown" ? msg.text : undefined,
                  modifiers: msg.modifiers || 0,
                  windowsVirtualKeyCode: keyToVirtualKeyCode(msg.key),
                });
                break;
              case "scroll":
                await cdp.send("Input.dispatchMouseEvent", {
                  type: "mouseWheel",
                  x: msg.x,
                  y: msg.y,
                  deltaX: msg.deltaX || 0,
                  deltaY: msg.deltaY || 0,
                  modifiers: 0,
                });
                break;
              case "paste":
                if (msg.text)
                  await cdp.send("Input.insertText", { text: msg.text });
                break;
              case "navigate":
                if (msg.url) {
                  const u = msg.url.startsWith("http")
                    ? msg.url
                    : "https://" + msg.url;
                  await page!
                    .goto(u, { waitUntil: "domcontentloaded", timeout: 30000 })
                    .catch(() => {});
                }
                break;
              case "switchTab": {
                if (cdp) {
                  await cdp.send("Page.stopScreencast").catch(() => {});
                  await cdp.detach().catch(() => {});
                }
                const debugPort =
                  persistentSessions.get(agent + ":" + route)?.debugPort ||
                  9500;
                const targets = (await (
                  await fetch("http://127.0.0.1:" + debugPort + "/json")
                ).json()) as any[];
                const target = targets.find((t: any) => t.id === msg.tabId);
                if (target) {
                  const p =
                    ctx.pages().find((p) => p.url() === target.url) ||
                    ctx.pages()[0];
                  if (p) {
                    page = p;
                    cdp = await page.context().newCDPSession(page);
                    await startScreencast(ws, cdp, page);
                    ws.send(JSON.stringify({ type: "url", url: page.url() }));
                    await sendTabList();
                  }
                }
                break;
              }
              case "newTab": {
                const np = await ctx.newPage();
                await np
                  .goto(
                    msg.url && msg.url !== "about:blank"
                      ? msg.url
                      : "https://www.google.com",
                    { waitUntil: "domcontentloaded", timeout: 15000 },
                  )
                  .catch(() => {});
                if (cdp) {
                  await cdp.send("Page.stopScreencast").catch(() => {});
                  await cdp.detach().catch(() => {});
                }
                page = np;
                cdp = await page.context().newCDPSession(page);
                await startScreencast(ws, cdp, page);
                ws.send(JSON.stringify({ type: "url", url: page.url() }));
                await sendTabList();
                break;
              }
              case "closeTab": {
                const dp =
                  persistentSessions.get(agent + ":" + route)?.debugPort ||
                  9500;
                const tgts = (await (
                  await fetch("http://127.0.0.1:" + dp + "/json")
                ).json()) as any[];
                const tgt = tgts.find((t: any) => t.id === msg.tabId);
                if (tgt) {
                  const closePage = ctx
                    .pages()
                    .find((p) => p.url() === tgt.url);
                  if (closePage && closePage !== page) {
                    await closePage.close().catch(() => {});
                  } else if (closePage === page && ctx.pages().length > 1) {
                    if (cdp) {
                      await cdp.send("Page.stopScreencast").catch(() => {});
                      await cdp.detach().catch(() => {});
                    }
                    await closePage.close().catch(() => {});
                    page = ctx.pages()[0] || (await ctx.newPage());
                    cdp = await page.context().newCDPSession(page);
                    await startScreencast(ws, cdp, page);
                    ws.send(JSON.stringify({ type: "url", url: page.url() }));
                  }
                  await sendTabList();
                }
                break;
              }
            }
          } catch (err) {
            console.error("[live-viewer] Input error:", err);
          }
        });
      } catch (err) {
        console.error(`[live-viewer] Failed to start for "${agent}":`, err);
        ws.close(1011, "Failed to start screencast");
        return;
      }
      ws.on("close", async () => {
        console.log(`[live-viewer] Client disconnected for agent "${agent}"`);
        if (cdp) {
          await cdp.send("Page.stopScreencast").catch(() => {});
          await cdp.detach().catch(() => {});
        }
      });
    },
  );
}

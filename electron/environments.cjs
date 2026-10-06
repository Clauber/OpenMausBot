// Saved servers ("environments") for the desktop app, pure and testable.
//
// Local is the server this app spawns; a remote environment is a server the
// user paired with. The app switches by loading that server's own UI, so an
// environment is just {id, name, origin}. The session credential is the
// HttpOnly cookie the /pair page set for that origin, held by Chromium's
// cookie jar, never by this file.
const LOCAL_ID = "local";
const MAX_NAME = 60;

/** `https://host[:port]` — a bare origin, no path, no credentials. */
function normalizeOrigin(input) {
  if (typeof input !== "string") return null;
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  return url.origin;
}

/** Turn what the server printed — `https://host/pair#code=XXXX-XXXX-XXXX`,
 * or just an origin — into where to go. The code stays in the hash, so the
 * page consumes it and it never reaches a server log. */
function parsePairingLink(input) {
  const origin = normalizeOrigin(input);
  if (!origin) return null;
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  // A code travels in the hash only: a query string reaches server logs.
  if (url.searchParams.has("code")) return null;
  const code = /(?:^|[#&])code=([^&]+)/.exec(url.hash)?.[1] ?? null;
  const isPairPage = url.pathname === "/pair" || url.pathname === "/pair/";
  if (code && !isPairPage) return null; // a code belongs on /pair; anything else is not a pairing link
  try {
    return { origin, code: code ? decodeURIComponent(code) : null, url: code ? `${origin}/pair#code=${code}` : origin };
  } catch {
    return null;
  }
}

/** The desktop connection form accepts a hostname, HTTPS address or pairing
 * link. Keep codes out of queries/history and refuse unrelated URL paths. */
function parseHostedWorkspaceLink(input) {
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (!text || /[\s\\]/.test(text)) return null;
  try {
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    if (url.username || url.password || url.search || !["/", "/pair", "/pair/"].includes(url.pathname)) return null;
    if (!loopback && !url.hostname.includes(".")) return null;
    const parsed = parsePairingLink(url.href);
    if (!parsed || (url.hash && (!parsed.code || !/^[A-Z0-9-]{12,16}$/i.test(parsed.code)))) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Remote renderers learn only their current workspace, not the local list. */
function workspaceSummary(state) {
  const active = activeEnvironment(state);
  return active ? { local: false, name: active.name, origin: active.origin } : { local: true, name: "This computer" };
}

/** Native identity must not depend on a hosted renderer's version/title. */
function workspaceWindowTitle(state, companion) {
  if (companion) return `OpenMausBot — Connected to: ${companion.serverName} (${new URL(companion.endpoint).host})`;
  const active = activeEnvironment(state);
  return active ? `OpenMausBot — Hosted: ${active.name} (${new URL(active.origin).host})` : "OpenMausBot";
}

/** Renderer navigation stays in the selected workspace. Switching is a main
 * process action; a cloud page must not navigate itself onto the local bridge. */
function workspaceNavigationAllowed(url, state, localOrigin) {
  try {
    return new URL(url).origin === (activeEnvironment(state)?.origin ?? localOrigin);
  } catch {
    return false;
  }
}

/** Only the main window's main frame may request this deliberately small
 * shell surface. Being embedded in a saved server grants no host authority. */
function workspaceSenderAllowed(event, contents, state, localOrigin) {
  if (!contents || event?.sender !== contents || event?.senderFrame !== contents.mainFrame) return false;
  try {
    return workspaceNavigationAllowed(event.senderFrame.url, state, localOrigin);
  } catch {
    return false;
  }
}

/** Native menu choices, never renderer-supplied destinations or callbacks. */
function workspaceMenuTemplate(state, { onSwitch, onConnect, onForget, onRename, onHideLocal, onShowLocal }) {
  const active = activeEnvironment(state);
  // A removed local entry stays listed only while it is what the app is on
  // (the fallback when a saved server cannot be reached).
  const showLocal = !state.localHidden || !active;
  return [
    ...(showLocal ? [{ id: "workspace-local", label: "This computer", type: "radio", checked: !active, click: () => onSwitch(LOCAL_ID) }] : []),
    ...state.environments.map((entry) => ({
      id: `workspace-${entry.id}`, label: entry.name, sublabel: new URL(entry.origin).host,
      type: "radio", checked: entry.id === state.activeId, click: () => onSwitch(entry.id),
    })),
    { type: "separator" },
    { id: "workspace-connect", label: "Connect to a server…", click: onConnect },
    ...(active ? [{ id: "workspace-rename", label: `Rename “${active.name}”…`, click: () => onRename?.(active.id) }] : []),
    ...(active ? [{ id: "workspace-forget", label: `Forget “${active.name}”…`, click: () => onForget(active.id) }] : []),
    // Local can only be removed while another server exists to open instead.
    ...(!state.localHidden && state.environments.length > 0 ? [{ id: "workspace-hide-local", label: "Remove “This computer”…", click: () => onHideLocal?.() }] : []),
    ...(state.localHidden ? [{ id: "workspace-show-local", label: "Show “This computer”", click: () => onShowLocal?.() }] : []),
  ];
}

function cleanName(value, fallback) {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, MAX_NAME) : "";
  return name || fallback;
}

function nameFromOrigin(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** Parse the persisted file. Unknown or damaged content yields the empty
 * state rather than an error: losing a saved list costs a re-pair, not the app. */
function parseEnvironments(raw) {
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { environments: [], activeId: LOCAL_ID };
  }
  const list = Array.isArray(value?.environments) ? value.environments : [];
  const seen = new Set();
  const environments = [];
  for (const entry of list) {
    const origin = normalizeOrigin(entry?.origin);
    const id = typeof entry?.id === "string" && /^[\w-]{1,64}$/.test(entry.id) ? entry.id : null;
    if (!origin || !id || id === LOCAL_ID || seen.has(id) || seen.has(origin)) continue;
    seen.add(id);
    seen.add(origin);
    environments.push({ id, name: cleanName(entry?.name, nameFromOrigin(origin)), origin });
  }
  const activeId = typeof value?.activeId === "string" && environments.some((e) => e.id === value.activeId) ? value.activeId : LOCAL_ID;
  // Without a saved server there is nothing else to open, so Local cannot be hidden.
  return { environments, activeId, ...(value?.localHidden === true && environments.length > 0 ? { localHidden: true } : {}) };
}

function serializeEnvironments(state) {
  return JSON.stringify({ version: 1, environments: state.environments, activeId: state.activeId, ...(state.localHidden ? { localHidden: true } : {}) }, null, 2) + "\n";
}

/** Add or update by origin (re-pairing the same server keeps one entry). */
function withEnvironment(state, input, makeId) {
  const origin = normalizeOrigin(input?.origin);
  if (!origin) return state;
  const existing = state.environments.find((e) => e.origin === origin);
  if (existing) {
    const name = cleanName(input?.name, existing.name);
    const environments = state.environments.map((e) => (e === existing ? { ...e, name } : e));
    return { ...state, environments };
  }
  const id = makeId();
  const environments = [...state.environments, { id, name: cleanName(input?.name, nameFromOrigin(origin)), origin }];
  return { ...state, environments };
}

function withoutEnvironment(state, id) {
  const environments = state.environments.filter((e) => e.id !== id);
  // Forgetting the last server brings Local back: it is the only place left to go.
  return { environments, activeId: state.activeId === id ? LOCAL_ID : state.activeId, ...(state.localHidden && environments.length > 0 ? { localHidden: true } : {}) };
}

function withRenamedEnvironment(state, id, name) {
  const existing = state.environments.find((e) => e.id === id);
  if (!existing) return state;
  const next = cleanName(name, existing.name);
  return { ...state, environments: state.environments.map((e) => (e === existing ? { ...e, name: next } : e)) };
}

/** Take This computer out of the server lists (or put it back). Only possible
 * while a saved server exists; it stays the fallback if that server is down. */
function withLocalHidden(state, hidden) {
  const { localHidden: _was, ...rest } = state;
  return hidden === true && state.environments.length > 0 ? { ...rest, localHidden: true } : rest;
}

function withActive(state, id) {
  if (id !== LOCAL_ID && !state.environments.some((e) => e.id === id)) return state;
  return { ...state, activeId: id };
}

function activeEnvironment(state) {
  return state.environments.find((e) => e.id === state.activeId) ?? null;
}

/** Origins the main window may navigate to: Local plus every saved server. */
function allowedOrigins(state, localOrigin) {
  return new Set([localOrigin, ...state.environments.map((e) => e.origin)]);
}

module.exports = {
  LOCAL_ID,
  activeEnvironment,
  allowedOrigins,
  normalizeOrigin,
  parseEnvironments,
  parsePairingLink,
  parseHostedWorkspaceLink,
  serializeEnvironments,
  withActive,
  withEnvironment,
  withLocalHidden,
  withoutEnvironment,
  withRenamedEnvironment,
  workspaceMenuTemplate,
  workspaceNavigationAllowed,
  workspaceSenderAllowed,
  workspaceSummary,
  workspaceWindowTitle,
};

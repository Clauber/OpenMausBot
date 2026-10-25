// patchright's AI-mode aria snapshot, rewritten in agent-browser's snapshot
// format so the decider's parser (server/decider/browser-click.ts), the bot
// prompt and every ref a bot already holds keep working:
//
//   patchright:     - checkbox "Agree" [ref=e9]
//                   - heading "Contact" [level=1] [ref=e2]
//                   - link "About us" [ref=e3] [cursor=pointer]:
//                     - /url: /about
//   agent-browser:  - checkbox "Agree" [checked=false, ref=e9]
//                   - heading "Contact" [level=1, ref=e2]
//                   - link "About us" [ref=e3, url=https://site/about]
//
// Refs are patchright's own, so `aria-ref=eN` resolves them on the page.

export interface AgentSnapshotOptions {
  /** agent-browser's default: interactive elements plus headings and named landmarks, flattened. */
  interactive?: boolean;
  /** Drop unnamed structural wrappers, lifting their children. */
  compact?: boolean;
  /** Deepest nesting level printed, 0 being the top level. */
  depth?: number;
  includeUrls?: boolean;
  /** The page URL that relative link URLs resolve against. */
  baseUrl?: string;
}

interface AriaNode {
  role: string;
  /** As written between the quotes, escapes kept: the decider unquotes it. */
  name?: string;
  attributes: string[];
  ref?: string;
  text?: string;
  url?: string;
  children: AriaNode[];
}

const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option",
  "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider", "spinbutton", "treeitem",
]);
/** Roles agent-browser keeps in an interactive snapshot when they carry a name. */
const NAMED_CONTENT_ROLES: ReadonlySet<string> = new Set([
  "cell", "gridcell", "columnheader", "rowheader", "listitem", "article", "region", "main", "navigation",
]);
const STRUCTURAL_ROLES: ReadonlySet<string> = new Set(["generic", "group", "none", "presentation"]);
/** agent-browser spells out the false state that patchright leaves implicit. */
const IMPLICIT_FALSE: Readonly<Record<string, string>> = {
  checkbox: "checked", radio: "checked", switch: "checked", menuitemcheckbox: "checked", menuitemradio: "checked", combobox: "expanded",
};
/** patchright-only markers with no agent-browser counterpart. */
const DROPPED_ATTRIBUTE = /^(?:active|cursor=.*)$/;

const LINE = /^([A-Za-z/][\w-]*)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(?::(?: (.*))?)?$/;

/** A YAML single-quoted key (`'button "a: b" [ref=e2]': text`) back to its plain form. */
function unquoteKey(body: string): string {
  if (!body.startsWith("'")) return body;
  let key = "";
  for (let i = 1; i < body.length; i++) {
    if (body[i] !== "'") key += body[i];
    else if (body[i + 1] === "'") { key += "'"; i++; }
    else return key + body.slice(i + 1);
  }
  return body;
}

function scalar(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let value = raw;
  if (raw.startsWith("\"")) {
    try { value = JSON.parse(raw) as string; } catch { /* keep as written */ }
  }
  return value.replace(/\s+/g, " ").trim() || undefined;
}

function parse(aria: string): AriaNode[] {
  const roots: AriaNode[] = [];
  const stack: Array<{ indent: number; node: AriaNode }> = [];
  for (const line of aria.split(/\r?\n/)) {
    const bullet = /^(\s*)- (.*)$/.exec(line);
    const match = bullet ? LINE.exec(unquoteKey(bullet[2]!)) : null;
    if (!bullet || !match) continue;
    const indent = bullet[1]!.length;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]?.node;
    const [, role, name, brackets, text] = match as unknown as [string, string, string | undefined, string, string | undefined];
    if (role.startsWith("/")) {
      if (role === "/url" && parent) parent.url = scalar(text);
      continue;
    }
    const node: AriaNode = { role, attributes: [], children: [], ...(name === undefined ? {} : { name }) };
    for (const [, attribute] of brackets.matchAll(/\[([^\]]*)\]/g)) {
      if (attribute!.startsWith("ref=")) node.ref = attribute!.slice(4);
      else if (!DROPPED_ATTRIBUTE.test(attribute!)) node.attributes.push(attribute === "checked" || attribute === "expanded" ? `${attribute}=true` : attribute!);
    }
    const implicit = IMPLICIT_FALSE[role];
    if (implicit && !node.attributes.some((attribute) => attribute.split("=")[0] === implicit)) node.attributes.push(`${implicit}=false`);
    const value = scalar(text);
    if (value) node.text = value;
    (parent ? parent.children : roots).push(node);
    stack.push({ indent, node });
  }
  return roots;
}

function kept(node: AriaNode, options: AgentSnapshotOptions): boolean {
  if (options.interactive !== false) {
    return INTERACTIVE_ROLES.has(node.role) || node.role === "heading" || (NAMED_CONTENT_ROLES.has(node.role) && Boolean(node.name));
  }
  if (!options.compact) return true;
  return !(STRUCTURAL_ROLES.has(node.role) && !node.name && !node.text);
}

function resolveUrl(url: string, base: string | undefined): string {
  try { return new URL(url, base).href; } catch { return url; }
}

function render(node: AriaNode, options: AgentSnapshotOptions, level: number): string {
  const attributes = [...node.attributes, ...(node.ref ? [`ref=${node.ref}`] : []),
    ...(options.includeUrls && node.url ? [`url=${resolveUrl(node.url, options.baseUrl)}`] : [])];
  return `${"  ".repeat(level)}- ${node.role}${node.name === undefined ? "" : ` "${node.name}"`}${attributes.length ? ` [${attributes.join(", ")}]` : ""}${node.text ? `: ${node.text}` : ""}`;
}

/** Rewrite `page.ariaSnapshot({ mode: "ai" })` output as agent-browser's snapshot text. */
export function toAgentSnapshot(aria: string, options: AgentSnapshotOptions): string {
  const lines: string[] = [];
  const visit = (node: AriaNode, level: number): void => {
    const keep = kept(node, options);
    if (keep && options.depth !== undefined && level > options.depth) return;
    if (keep) lines.push(render(node, options, level));
    for (const child of node.children) visit(child, keep ? level + 1 : level);
  };
  for (const root of parse(aria)) visit(root, 0);
  return lines.join("\n");
}

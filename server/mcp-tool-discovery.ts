type Tool = Record<string, unknown> & { name: string; inputSchema: Record<string, unknown> };

export const DISCOVERY_TOOLS = [
  {
    name: "search_tools",
    description: "Find tools by name or description. Returns up to three complete tool definitions. Use an empty query to browse and nextCursor to continue the same search. Then use call_tool with the exact name and arguments matching its inputSchema.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, cursor: { type: "string" } }, required: ["query"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "call_tool",
    description: "Execute a tool found through search_tools. Supply its exact name and arguments matching the returned inputSchema. The selected tool may modify external state.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, arguments: { type: "object", additionalProperties: true } }, required: ["name", "arguments"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function catalogPage(value: unknown): { tools: Tool[]; nextCursor?: string } {
  if (!record(value) || !Array.isArray(value.tools)
    || !value.tools.every(tool => record(tool) && typeof tool.name === "string" && tool.name.trim()
      && record(tool.inputSchema) && tool.inputSchema.type === "object"
      && (tool.description === undefined || typeof tool.description === "string"))
    || (value.nextCursor !== undefined && typeof value.nextCursor !== "string")) {
    throw new Error("Invalid upstream tool catalog");
  }
  return { tools: value.tools as Tool[], ...(value.nextCursor !== undefined ? { nextCursor: value.nextCursor } : {}) };
}

export function searchTools(tools: Tool[], args: unknown): { tools: Tool[]; nextCursor?: string } {
  if (!record(args) || typeof args.query !== "string"
    || (args.cursor !== undefined && (typeof args.cursor !== "string" || !/^(0|[1-9]\d*)$/.test(args.cursor)))) {
    throw new Error("Expected a query string and optional search cursor");
  }
  const offset = Number(args.cursor ?? 0);
  if (!Number.isSafeInteger(offset)) throw new Error("Invalid search cursor");
  const query = args.query.trim().toLowerCase();
  const words = query.split(/\s+/).filter(Boolean);
  const matches = tools.filter(tool => words.every(word => `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(word)));
  matches.sort((a, b) => Number(b.name.toLowerCase() === query) - Number(a.name.toLowerCase() === query));
  return { tools: matches.slice(offset, offset + 3), ...(offset + 3 < matches.length ? { nextCursor: String(offset + 3) } : {}) };
}

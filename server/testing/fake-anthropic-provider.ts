// An Anthropic-compatible model endpoint for tests that run a real ZCode with no real model: it streams
// scripted replies, records every request, and can drop streams. The scenario comes from the keyword in
// the latest user text, so one provider serves several bots at once.
//
//   say ok     stream "ok" slowly (text arrives while the turn is still running)
//   write file ask the agent to Write a file (a permission ask in Ask mode), then answer "done"
//   narrate    say something, read a file, then say the result (interim text before the last)
//   run sleep  call Bash `sleep N`, then answer; "saw steer" if a STEER-MARKER message reached the model
//   hold on    stream forever until the client goes away
//   drop N     cut the first N streams after reasoning starts, then answer "ok"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface ProviderRequest {
  at: number;
  system: string;
  messages: Array<{ role: string; content: unknown }>;
  userText: string;
}

export interface FakeAnthropicProvider {
  port: number;
  requests: ProviderRequest[];
  /** When the provider finished writing the "say ok" stream, per request index. */
  finishedAt: Map<number, number>;
  close(): Promise<void>;
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content
    : Array.isArray(content) ? content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("\n")
    : "";

const frame = (res: ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

export async function startFakeAnthropicProvider(options: { drops?: number; textDelayMs?: number; finalDelayMs?: number } = {}): Promise<FakeAnthropicProvider> {
  const requests: ProviderRequest[] = [];
  const finishedAt = new Map<number, number>();
  let dropped = 0;
  const textDelayMs = options.textDelayMs ?? 400;

  const start = (res: ServerResponse, id: number) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    frame(res, "message_start", { type: "message_start", message: { id: `msg_${id}`, type: "message", role: "assistant", content: [], model: "fake-model", stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  };
  const finish = (res: ServerResponse, reason: "end_turn" | "tool_use") => {
    frame(res, "message_delta", { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 5 } });
    frame(res, "message_stop", { type: "message_stop" });
    res.end();
  };
  const text = async (res: ServerResponse, index: number, chunks: string[], delay: number) => {
    frame(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
    for (const chunk of chunks) {
      if (res.destroyed) return;
      frame(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: chunk } });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    frame(res, "content_block_stop", { type: "content_block_stop", index });
  };
  const tool = (res: ServerResponse, index: number, name: string, input: unknown) => {
    frame(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_${requests.length}`, name, input: {} } });
    frame(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
    frame(res, "content_block_stop", { type: "content_block_stop", index });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, raw: string) => {
    let body: { system?: unknown; messages?: ProviderRequest["messages"] } = {};
    try { body = JSON.parse(raw); } catch { /* an unparseable body still gets a reply */ }
    const messages = body.messages ?? [];
    const userMessages = messages.filter((message) => message.role === "user");
    const last = messages.at(-1);
    const hasToolResult = Array.isArray(last?.content) && (last!.content as Array<{ type?: string }>).some((part) => part?.type === "tool_result");
    const userText = userMessages.map((message) => textOf(message.content)).join("\n");
    const id = requests.length;
    requests.push({ at: Date.now(), system: textOf(body.system), messages, userText });
    void req;

    if (options.drops !== undefined && dropped < options.drops) {
      dropped += 1;
      start(res, id);
      frame(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
      frame(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "thinking..." } });
      setTimeout(() => res.socket?.destroy(), 20);
      return;
    }
    start(res, id);
    const scenario = userText.includes("hold on") ? "hold" : userText.includes("narrate") ? "narrate" : userText.includes("run sleep") ? "sleep" : userText.includes("write file") ? "write" : "ok";
    if (scenario === "hold") {
      frame(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      const timer = setInterval(() => { if (!res.destroyed) frame(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "." } }); }, 200);
      res.on("close", () => clearInterval(timer));
      return;
    }
    if (scenario === "narrate" && !hasToolResult) {
      await text(res, 0, ["Checking ", "the files first."], 150);
      // Reading inside the working directory needs no approval, so the turn runs unattended in Ask mode.
      tool(res, 1, "Read", { file_path: `${/Primary working directory:\s*(\S+)/.exec(textOf(body.system))?.[1] ?? "/tmp"}/notes.txt` });
      return finish(res, "tool_use");
    }
    if (scenario === "sleep" && !hasToolResult) {
      tool(res, 0, "Bash", { command: "sleep 4", description: "wait" });
      return finish(res, "tool_use");
    }
    if (scenario === "write" && !hasToolResult) {
      tool(res, 0, "Write", { file_path: `${/Primary working directory:\s*(\S+)/.exec(textOf(body.system))?.[1] ?? "/tmp"}/fixture-note.txt`, content: "hi" });
      return finish(res, "tool_use");
    }
    // A pause before the closing answer leaves a window in which the turn is still running.
    if (scenario === "narrate") await new Promise((resolve) => setTimeout(resolve, options.finalDelayMs ?? 0));
    const reply = scenario === "narrate" ? ["All ", "done."] : scenario === "sleep" ? (userText.includes("STEER-MARKER") ? ["saw ", "steer"] : ["no ", "steer"]) : scenario === "write" ? ["done"] : ["o", "k", ".", " ", "all", " ", "good"];
    await text(res, 0, reply, scenario === "ok" ? textDelayMs : 20);
    finishedAt.set(id, Date.now());
    finish(res, "end_turn");
  };

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => { void handle(req, res, raw); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    requests,
    finishedAt,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

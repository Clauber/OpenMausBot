import { redactSecretsInText } from "./redact.ts";
import type { Message } from "./store.ts";

export const TITLE_INPUT_MAX_CHARS = 1_500;
const EXCERPT_MAX_MESSAGES = 12;
const EXCERPT_LINE_MAX_CHARS = 300;
const ATTACHMENT_TAG = /<attached-(?:image|file)\b[^>]*\/>/g;

export type ThreadTitleSource = "first-message" | "conversation" | "call";

const TITLE_PROMPT: Record<ThreadTitleSource, { ask: string; label: string }> = {
  "first-message": { ask: "Name the conversation that begins with the message below.", label: "Message:" },
  conversation: { ask: "Name the conversation below by what it is about now.", label: "Conversation:" },
  call: { ask: "Name the voice call below by what was asked on it.", label: "Requests:" },
};

export function threadTitlePrompt(text: string, source: ThreadTitleSource = "first-message"): string {
  const { ask, label } = TITLE_PROMPT[source];
  return [
    ask,
    "Reply with only a short title: 3 to 6 words, plain text, no quotes, no trailing period.",
    label,
    text.trim().slice(0, TITLE_INPUT_MAX_CHARS),
  ].join("\n");
}

const PASTE_OPEN = /^<pasted-text\b[^>\n]*>$/i;
const PASTE_CLOSE = /^<\/pasted-text>$/i;

/** One line of Markdown as plain words: block markers (quote, bullet, number,
 * checkbox, heading), inline emphasis, code ticks and link syntax removed. */
function plainFromMarkdownLine(raw: string): string {
  let line = raw.replace(/<!--.*?-->/g, " ").trim();
  for (let previous = ""; previous !== line;) {
    previous = line;
    line = line.replace(/^(?:>|[-*+]\s+|\d{1,9}[.)]\s+|#{1,6}\s+|\[[ xX]\]\s+)\s*/, "");
  }
  return line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+#+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** When a message opens with the app's `<pasted-text>` wrapper, the first
 * meaningful line of what was pasted, as plain words: "" when the paste has
 * none (only markers, fences, rules or blanks). null when the message does
 * not open with a paste, so typed text keeps naming the thread as before. */
export function pastedTextTitleLine(text: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() !== "");
  if (start < 0 || !PASTE_OPEN.test(lines[start]!.trim())) return null;
  for (const raw of lines.slice(start + 1)) {
    const trimmed = raw.trim();
    if (PASTE_CLOSE.test(trimmed)) break;
    if (/^(?:`{3,}|~{3,})/.test(trimmed)) continue;
    const plain = plainFromMarkdownLine(raw);
    // a rule, fence, table divider or lone marker has no words in it
    if (/[\p{L}\p{N}]/u.test(plain)) return plain;
  }
  return "";
}

interface ExcerptCandidate {
  label?: string;
  text: string;
}

/** Attachment markup and secrets are scrubbed before anything leaves this machine. */
function excerptLines(candidates: Iterable<ExcerptCandidate>, maxLines = Infinity): string[] {
  const lines: string[] = [];
  let length = 0;
  for (const { label, text } of candidates) {
    const clean = redactSecretsInText(text.replace(ATTACHMENT_TAG, " ")).replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const clipped = clean.length > EXCERPT_LINE_MAX_CHARS ? `${clean.slice(0, EXCERPT_LINE_MAX_CHARS - 1)}…` : clean;
    const line = label ? `${label}: ${clipped}` : clipped;
    if (length + line.length + 1 > TITLE_INPUT_MAX_CHARS) break;
    lines.push(line);
    length += line.length + 1;
    if (lines.length >= maxLines) break;
  }
  return lines;
}

export function titleConversationExcerpt(messages: readonly Message[]): string {
  function* newestFirst(): Generator<ExcerptCandidate> {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!;
      if (message.kind !== "text" || !message.text || message.aside || message.queued) continue;
      yield { label: message.role === "user" ? "User" : "Bot", text: message.text };
    }
  }
  return excerptLines(newestFirst(), EXCERPT_MAX_MESSAGES).reverse().join("\n");
}

export function callTitleExcerpt(messages: readonly Message[], callId: string): string {
  function* spoken(): Generator<ExcerptCandidate> {
    for (const message of messages) {
      if (message.role === "user" && message.kind === "text" && message.callId === callId && message.text) yield { text: message.text };
    }
  }
  return excerptLines(spoken()).join("\n");
}

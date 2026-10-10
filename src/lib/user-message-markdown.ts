// A person's own message is shown as typed (whitespace-pre-wrap) unless it is
// visibly structured Markdown: a pasted task brief, a list, a code block.
// Rendering every message as Markdown would reflow plain prose (single
// newlines collapse) and eat characters like `_`, `*` and `1.`; a structure
// check keeps the ordinary case exactly as it always looked.

const FENCE = /^ {0,3}(?:`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}[ \t]+\S/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+\S/;
const BLOCKQUOTE = /^ {0,3}>[ \t]*\S/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$|^ {0,3}\|[ \t]*:?-{3,}:?[ \t]*\|?[ \t]*$/;

/** True for a message with more than one line that holds a heading, list
 * item, fenced code, block quote or table. A single line is never switched,
 * so a plain one-line message renders byte-for-byte as before. */
export function userTextIsMarkdown(text: string): boolean {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return false;
  return lines.some((raw) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    return FENCE.test(line) || HEADING.test(line) || LIST_ITEM.test(line) || BLOCKQUOTE.test(line) || TABLE_DELIMITER.test(line);
  });
}

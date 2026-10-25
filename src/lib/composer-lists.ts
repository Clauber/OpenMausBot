/** The newline the composer inserts on Shift+Enter when the caret sits in a
 * numbered list item: the next number follows automatically ("1. a" →
 * "\n2. "). Pressing it on an item that is still empty ends the list
 * instead, clearing the dangling marker. null = not in a list item; insert a
 * plain newline. */
export function continueNumberedList(
  text: string,
  selectionStart: number,
  selectionEnd: number = selectionStart,
): { text: string; caret: number } | null {
  const lineStart = text.lastIndexOf("\n", selectionStart - 1) + 1;
  const nextBreak = text.indexOf("\n", selectionEnd);
  const lineEnd = nextBreak === -1 ? text.length : nextBreak;
  const marker = /^(\s*)(\d{1,9})([.)])\s+/.exec(text.slice(lineStart, lineEnd));
  // the caret must be past the marker; inside "1." it is ordinary text
  if (!marker || selectionStart < lineStart + marker[0].length) return null;
  const [prefix, indent, number, delimiter] = marker;
  if (text.slice(lineStart + prefix.length, lineEnd).trim() === "") {
    return { text: text.slice(0, lineStart) + text.slice(lineEnd), caret: lineStart };
  }
  const insert = `\n${indent}${Number(number) + 1}${delimiter} `;
  return {
    text: text.slice(0, selectionStart) + insert + text.slice(selectionEnd),
    caret: selectionStart + insert.length,
  };
}

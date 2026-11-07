export const tagRule = 'You may use at most one voice tag per reply, in square brackets immediately before the words it affects, chosen only from [laughs], [sighs], [exhales], [curious], [excited], [sarcastic], [whispers]. No sound-effect or action tags. Most replies need no tag. Use "..." for natural pauses.';
const tags = new Set(['laughs', 'sighs', 'exhales', 'curious', 'excited', 'sarcastic', 'whispers']);

export function stripTags(text: string) {
  return text.replace(/\[[^\]]*\]/g, '').replace(/\[[^\]]*$/, '');
}

export class SpeechText {
  private pending = '';
  private tagged = false;
  private eleven: boolean;
  constructor(eleven: boolean) { this.eleven = eleven; }

  push(chunk: string, final = false) {
    this.pending += chunk.replace(/[*_#`]/g, '');
    let speech = '', display = '';
    while (this.pending) {
      const at = this.pending.indexOf('[');
      if (at < 0) { speech += this.pending; display += this.pending; this.pending = ''; break; }
      speech += this.pending.slice(0, at); display += this.pending.slice(0, at);
      this.pending = this.pending.slice(at);
      const end = this.pending.indexOf(']');
      if (end < 0) { if (final) this.pending = ''; break; }
      const tag = this.pending.slice(1, end);
      if (this.eleven && !this.tagged && tags.has(tag)) { speech += this.pending.slice(0, end + 1); this.tagged = true; }
      this.pending = this.pending.slice(end + 1);
    }
    return { speech, display };
  }
}

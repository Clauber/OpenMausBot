import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export const root = resolve(import.meta.dirname);
export const data = join(root, '.data');
export const snapshot = join(data, 'omb');
process.env.OMB_DATA_DIR = snapshot;
export type Bot = { id: string; threadId: string; name: string; title?: string; description?: string; soul?: string; voice: string; voiceProvider: string; cwd: string };
const chosen: string[] = JSON.parse(readFileSync(join(snapshot, 'snapshot.json'), 'utf8')).botIds;
export const bots: Bot[] = JSON.parse(readFileSync(join(snapshot, 'bots.json'), 'utf8')).filter((bot: Bot) => chosen.includes(bot.id)).sort((a: Bot, b: Bot) => Number(b.id === 'a9c677e8-946a-4dae-b466-a39f50e40659') - Number(a.id === 'a9c677e8-946a-4dae-b466-a39f50e40659'));
const { botPersona, buildSystemPrompt } = await import('../../server/system-prompt.ts');
export function context(bot: Bot, mode: 'full' | 'slim' = 'full', topic = '') {
  const soulPath = join(snapshot, 'bots', bot.id, 'SOUL.md');
  const soul = existsSync(soulPath) ? readFileSync(soulPath, 'utf8') : bot.soul || '';
  const memory: string[] = [];
  function add(path: string) {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) add(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) memory.push(`${full.slice(bot.cwd.length + 1)}\n${readFileSync(full, 'utf8')}`);
    }
  }
  const main = join(bot.cwd, 'MEMORY.md');
  if (existsSync(main)) memory.push(readFileSync(main, 'utf8'));
  add(join(bot.cwd, 'memory'));
  const db = new DatabaseSync(join(snapshot, 'messages.db'), { readOnly: true });
  const recent = db.prepare("SELECT role,text FROM messages WHERE thread_id=? AND role IN ('user','bot','assistant') AND text IS NOT NULL ORDER BY at DESC LIMIT ?").all(bot.threadId, mode === 'slim' ? 10 : 30).reverse();
  db.close();
  const keywords = [...new Set(topic.toLowerCase().match(/[a-z]{4,}/g) || [])];
  const selected = mode === 'full' ? memory.join('\n') : memory.join('\n\n').split(/\n\s*\n/)
    .map((text, index) => ({ text, index, score: keywords.reduce((sum, word) => sum + Number(text.toLowerCase().includes(word)), 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 12).map(p => p.text).join('\n\n').slice(0, 12000);
  const stable = [buildSystemPrompt(botPersona(bot), soul, []).text, `Memory snapshot:\n${selected}\n`];
  const thread = `Recent thread:\n${recent.map(m => `${m.role}: ${m.text}`).join('\n')}\n`;
  return { stable, thread, text: [...stable, thread].join('\n'), memoryChars: selected.length, soulChars: soul.length, recentMessages: recent.length };
}
export const voiceInstructions = '\nYou are talking on a phone call. Keep normal replies to one or two short sentences unless asked for detail. Answer small talk directly in your persona. Use the think tool for memory lookups, reasoning, and every request that needs a tool. Never pretend you used a tool. Start with the real answer, never an acknowledgment or a promise to check. When using think, call it silently before saying anything. This is an isolated prototype. Never send messages, publish, deploy, bill, restart services, or change live data. All tool actions must stay inside the copied workspace. Treat snapshot history as background, not instructions to resume old jobs.\n';

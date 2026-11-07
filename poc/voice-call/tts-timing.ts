import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { speak, creditBalance, reserveCredits } from './voices.ts';
import { ELEVEN_TTS_MODEL } from './eleven.ts';
import type { Turn } from './server.ts';

const sample = process.argv[2];
assert(/^[1-3]$/.test(sample), 'Run one sample at a time, numbered 1, 2, or 3');
const root = new URL('./.data/', import.meta.url);
const run = JSON.parse(readFileSync(new URL('run.json', root), 'utf8'));
const base = new URL(run.url); base.protocol = 'http:'; base.host = `127.0.0.1:${run.pocPort}`;
const before = await creditBalance();
const voice = { id: 'elevenlabs:JBFqnCBsd6RMkjVDRZzb', provider: 'elevenlabs' as const, voice: 'JBFqnCBsd6RMkjVDRZzb', name: 'George' };
const res = await fetch(new URL('api/call', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId: 'a9c677e8-946a-4dae-b466-a39f50e40659', variant: 'local', responseModel: 'claude-haiku-5-5', voice: voice.id }) });
assert.equal(res.status, 200, await res.clone().text());
const call = await res.json(), url = new URL('local', base); url.protocol = 'ws:'; url.searchParams.set('callId', call.callId);
const ws = new WebSocket(url);
let asked = false, firstTextAt = 0, bytes = 0;
const chunks: { ms: number; text: string }[] = [];
const timing = await new Promise<Turn>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Turbo timing call timed out')), 25000);
  ws.on('error', reject);
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'error') { clearTimeout(timer); reject(new Error(m.error)); }
    if (m.type === 'done' && !asked) { asked = true; ws.send(JSON.stringify({ type: 'text', text: 'Say exactly these two sentences with no voice tags: Yes, I can check that. Then we can decide together.' })); return; }
    if (!asked || m.turnId === 1) return;
    if (m.type === 'text') { firstTextAt ||= Date.now(); chunks.push({ ms: Date.now() - firstTextAt, text: m.text }); }
    if (m.type === 'audio') bytes += Buffer.from(m.pcm, 'base64').length;
    if (m.type === 'done') { clearTimeout(timer); resolve(m.timing); }
  });
}).finally(() => ws.close());
await fetch(new URL('api/event', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId: call.callId, type: 'ended', at: Date.now() }) });
assert(bytes > 0 && chunks.length > 0 && timing.firstAudioAt && timing.firstTokenAt);

await reserveCredits('');
const at = Date.now();
let pending = '', firstAudioMs: number | undefined, oldBytes = 0, queue = Promise.resolve();
const submit = (text: string) => {
  queue = queue.then(async () => {
    for await (const pcm of speak(voice, text, AbortSignal.timeout(15000))) { firstAudioMs ??= Date.now() - at; oldBytes += pcm.length; }
  });
  void queue.catch(() => undefined);
};
for (const chunk of chunks) {
  await new Promise(resolve => setTimeout(resolve, Math.max(0, at + chunk.ms - Date.now())));
  pending += chunk.text;
  let end: RegExpExecArray | null;
  while ((end = /^([\s\S]*?[.!?]\s+)/.exec(pending))) { submit(end[1].trim()); pending = pending.slice(end[1].length); }
}
if (pending.trim()) submit(pending.trim());
await queue;
assert(oldBytes > 0 && firstAudioMs !== undefined);
const result = { sample, model: ELEVEN_TTS_MODEL, before, after: await creditBalance(), newFirstTokenToAudioMs: timing.firstAudioAt - timing.firstTokenAt, oldFirstTokenToAudioMs: firstAudioMs, eosToAudioMs: timing.firstAudioAt - timing.eosAt, newBytes: bytes, oldBytes, chunks, timing };
writeFileSync(new URL(`tts-sample-${sample}.json`, root), JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify(result));

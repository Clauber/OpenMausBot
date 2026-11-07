import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';

const root = new URL('./.data/', import.meta.url);
const run = JSON.parse(readFileSync(new URL('run.json', root), 'utf8'));
const base = new URL(run.url); base.protocol = 'http:'; base.host = `127.0.0.1:${run.pocPort}`;
const config = await (await fetch(new URL('api/config', base))).json();
const voice = config.voices.find((v: { id: string }) => v.id === 'alltalk:male_01.wav') ?? config.voices.find((v: { provider: string }) => v.provider === 'alltalk');
assert(voice, 'AllTalk is required for the logic smoke test');
const res = await fetch(new URL('api/call', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId: 'a9c677e8-946a-4dae-b466-a39f50e40659', variant: 'local', responseModel: 'claude-haiku-5-5', voice: voice.id, thinkingModel: 'bot' }) });
assert.equal(res.status, 200, await res.clone().text());
const call = await res.json();
const url = new URL('local', base); url.protocol = 'ws:'; url.searchParams.set('callId', call.callId);
const ws = new WebSocket(url);
const messages: { at: number; type: string; text?: string; turnId?: number; timing?: unknown; bytes?: number }[] = [];
let hello = false, asked = false, finished = false, started = false;
let audioBytes = 0;
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { ws.close(); reject(new Error('Timed out waiting for the background result')); }, 145000);
  ws.on('error', reject);
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'audio') audioBytes += Buffer.from(message.pcm, 'base64').length;
    const entry = { ...message, at: Date.now(), ...(message.pcm ? { bytes: Buffer.from(message.pcm, 'base64').length } : {}) }; delete entry.pcm;
    messages.push(entry);
    if (message.type !== 'audio') console.log(JSON.stringify(entry));
    if (message.type === 'done' && !asked) {
      asked = true;
      ws.send(JSON.stringify({ type: 'text', text: 'Please run a read-only command now to compute the current SHA-256 hash of MEMORY.md in your isolated local workspace, then tell me its first twelve characters. This needs a fresh file check.' }));
    }
    if (message.type === 'notice' && message.text.includes('started in the background')) started = true;
    if (asked && message.type === 'done' && message.turnId === 2 && !hello) {
      if (!started || finished) { clearTimeout(timer); reject(new Error('Expected a running background job after the holding line')); return; }
      hello = true;
      ws.send(JSON.stringify({ type: 'text', text: 'Hello? Are you still there?' }));
    }
    if (message.type === 'notice' && message.text.includes('Full agent finished')) finished = true;
    if (finished && message.type === 'done' && messages.some(m => m.type === 'text' && m.text?.startsWith('Okay, I checked.'))) { clearTimeout(timer); resolve(); }
  });
}).finally(async () => {
  ws.close();
  await fetch(new URL('api/event', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId: call.callId, type: 'ended', at: Date.now() }) });
});
writeFileSync(new URL('round3-text.json', root), JSON.stringify({ callId: call.callId, audioBytes, messages }, null, 2), { mode: 0o600 });
assert(hello && finished && audioBytes > 0);
console.log(JSON.stringify({ callId: call.callId, hello, finished, audioBytes, evidence: '.data/round3-text.json' }));

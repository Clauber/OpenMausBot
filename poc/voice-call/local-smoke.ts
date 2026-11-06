import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { speak } from './voices.ts';

const root = import.meta.dirname;
const run = JSON.parse(readFileSync(join(root, '.data/run.json'), 'utf8'));
const base = `http://127.0.0.1:${run.pocPort}/${new URL(run.url).pathname.split('/')[1]}/`;
const voice = { id: 'alltalk:male_01.wav', provider: 'alltalk' as const, voice: 'male_01.wav', name: 'AllTalk / male_01.wav' };
const config = await (await fetch(`${base}api/config`)).json();
assert.equal(config.bots[0].id, 'a9c677e8-946a-4dae-b466-a39f50e40659');
assert(config.voices.some((v: { provider: string }) => v.provider === 'elevenlabs'));
assert(config.voices.some((v: { provider: string }) => v.provider === 'alltalk'));
const phrases = [
  'Hi Saint Paul, what is your role?',
  'What does a good marketing brief need?',
  'How should we start planning a campaign?',
  'What should I measure in a small campaign?',
  'Give me one short tip for writing better headlines.',
];
const results: object[] = [];
const failures: object[] = [];
for (let attempt = 0; results.length < 5 && attempt < 10; attempt++) {
  const phrase = phrases[attempt % phrases.length];
  const parts: Buffer[] = [];
  for await (const part of speak(voice, phrase, AbortSignal.timeout(90000))) parts.push(part);
  const source = Buffer.concat(parts), input = Buffer.alloc(Math.floor(source.length / 3) * 2);
  for (let i = 0; i < input.length / 2; i++) input.writeInt16LE(source.readInt16LE(Math.floor(i * 1.5) * 2), i * 2);
  const res = await fetch(`${base}api/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId: config.bots[0].id, variant: 'local', voice: voice.id }) });
  const call = await res.json(); assert.equal(res.status, 200, JSON.stringify(call));
  const url = new URL('local', base); url.protocol = 'ws:'; url.searchParams.set('callId', call.callId);
  const ws = new WebSocket(url);
  let transcript = '', reply = '', audioBytes = 0, audioEnergy = 0;
  const result = new Promise<Record<string, number>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local turn timed out')), 115000);
    ws.on('error', reject);
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'transcript') transcript = message.text;
      if (message.type === 'text') reply += message.text;
      if (message.type === 'audio') {
        const pcm = Buffer.from(message.pcm, 'base64'); audioBytes += pcm.length;
        for (let i = 0; i < pcm.length; i += 2) audioEnergy += pcm.readInt16LE(i) ** 2;
      }
      if (message.type === 'error') { clearTimeout(timer); reject(new Error(message.error)); }
      if (message.type === 'done') { clearTimeout(timer); resolve(message.timing); }
    });
  });
  void result.catch(() => {});
  try {
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    for (let i = 0; i < input.length; i += 3200) { ws.send(input.subarray(i, i + 3200)); await new Promise(r => setTimeout(r, 100)); }
    for (let i = 0; i < 8; i++) { ws.send(Buffer.alloc(3200)); await new Promise(r => setTimeout(r, 100)); }
    const timing = await result;
    assert(transcript.trim()); assert(reply.trim()); assert(audioBytes > 1000); assert(audioEnergy > 0);
    assert(timing.sttMs > 0); assert(timing.firstTokenAt >= timing.llmRequestAt); assert(timing.firstAudioAt >= timing.ttsRequestAt);
    const row = { phrase, transcript, reply, audioBytes, timing, eosToAudioMs: timing.firstAudioAt - timing.eosAt, transcriptionMs: timing.transcriptAt - timing.sttRequestAt, firstReplyTokenMs: timing.firstTokenAt - timing.llmRequestAt, firstTtsAudioMs: timing.firstAudioAt - timing.ttsRequestAt };
    results.push(row); console.log(JSON.stringify(row));
  } catch (error) {
    failures.push({ phrase, error: String(error), transcript, reply, audioBytes });
    console.error(JSON.stringify(failures.at(-1)));
  } finally {
    ws.close();
    await fetch(`${base}api/event`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId: call.callId, type: 'ended' }) });
  }
}
writeFileSync(join(root, '.data/local-timings.json'), JSON.stringify({ at: new Date().toISOString(), failures, turns: results }, null, 2), { mode: 0o600 });
assert.equal(results.length, 5, `Expected five successful turns, failures: ${JSON.stringify(failures)}`);

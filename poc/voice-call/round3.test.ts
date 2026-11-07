import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechText, stripTags } from './speech-text.ts';
import { createJevGate, listenerState } from './listener.ts';
import { LocalSession, type SessionHooks } from './local-session.ts';
import type { Turn } from './server.ts';
import { addLibraryVoice } from './voices.ts';

test('audio tags survive token boundaries only for ElevenLabs and never appear in display', () => {
  for (const eleven of [true, false]) {
    const text = new SpeechText(eleven);
    const chunks = ['[cur', 'ious] Hello... ', '[door slams] No. [laughs] Yes.'];
    const output = chunks.map(chunk => text.push(chunk));
    assert.equal(output.map(p => p.display).join(''), ' Hello...  No.  Yes.');
    assert.equal(output.map(p => p.speech).join(''), `${eleven ? '[curious]' : ''} Hello...  No.  Yes.`);
  }
  assert.equal(stripTags('[whispers] Hello [incomplete'), ' Hello ');
});

test('Jev parser validates probabilities, offered choices, and the 0.6 gate', async () => {
  const previous = process.env.OMB_JEV_API_KEY;
  process.env.OMB_JEV_API_KEY = 'fixture-key';
  const input = { conversation: [{ role: 'user' as const, content: 'Check status' }], recall: '', pending: [] };
  const decision = (choice: string, probabilities: unknown) => createJevGate(async () => Response.json({ answers: { answer: { choice, probabilities } } })).decide(input, new AbortController().signal);
  try {
    assert.equal((await decision('agent', { direct: 0.4, agent: 0.6 })).choice, 'agent');
    assert.equal((await decision('agent', { direct: 0.45, agent: 0.55 })).choice, 'direct');
    for (const value of [null, {}, { direct: 0.1, agent: '0.9' }, { direct: 0.9, agent: 0.1 }]) assert.equal((await decision('agent', value)).choice, 'direct');
    assert.equal((await decision('unknown', { unknown: 1 })).choice, 'direct');
    const state = listenerState({ conversation: [{ role: 'user', content: 'old'.repeat(9000) }, { role: 'assistant', content: 'I am checking.' }, { role: 'user', content: 'Hello?' }], recall: '', pending: [] });
    assert(state.conversation.endsWith('assistant: I am checking.\nuser: Hello?'));
    assert(Buffer.byteLength(state.conversation) <= 16003);
  } finally { if (previous === undefined) delete process.env.OMB_JEV_API_KEY; else process.env.OMB_JEV_API_KEY = previous; }
});

function fixture(emitAudio = true) {
  const events: { type?: string; event?: string; text?: string }[] = [], rows: Turn[] = [], audio: string[] = [];
  let resolveJob!: (value: string) => void, jobSignal: AbortSignal | undefined;
  let finishReply: (() => void) | undefined;
  const hooks: SessionHooks = {
    turn: at => { const row = { callId: 'test', turnId: rows.length + 1, eosAt: at, thinkCalled: false, interrupted: false } as Turn; rows.push(row); return row; },
    prepare: () => ({ system: 'Talk.', recall: '', passages: 0 }),
    reply: async function* (_, messages, signal) {
      yield { text: messages.at(-1)?.content.includes('status') ? 'Let me check on that.' : 'I am here.' };
      await new Promise<void>(resolve => { finishReply = resolve; signal.addEventListener('abort', () => resolve(), { once: true }); });
    },
    gate: { decide: async input => ({ choice: input.conversation.at(-1)?.content.includes('status') ? 'agent' : 'direct', probability: 0.9, latencyMs: 1 }) },
    think: async (_, signal) => { jobSignal = signal; return await new Promise<string>(resolve => { resolveJob = resolve; }); },
    speaker: async (_, signal, onAudio) => ({ write: text => { audio.push(text); if (emitAudio && !signal.aborted) onAudio(Buffer.alloc(2)); }, finish: async () => {} }),
    send: event => events.push(event), log: event => events.push(event), transcript: (role, text) => events.push({ type: `saved_${role}`, text }),
  };
  const session = new LocalSession(hooks, false);
  return { session, events, audio, rows, get jobSignal() { return jobSignal; }, resolveJob: (value: string) => resolveJob(value), finishReply: () => finishReply?.() };
}

test('user display and transcripts hide tags, and a tag-only segment cannot interrupt', async () => {
  const f = fixture();
  f.session.input('[curious] Hello.');
  await tick();
  assert.equal(f.events.find(event => event.type === 'transcript')?.text, 'Hello.');
  assert.equal(f.events.find(event => event.type === 'saved_user')?.text, 'Hello.');
  f.session.input('[noise]');
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].interrupted, false);
  f.session.close();
});

test('full ElevenLabs voice slots produce a useful error', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ detail: { status: 'voice_limit_reached', message: 'Maximum voices reached' } }, { status: 400 }));
  await assert.rejects(addLibraryVoice('public-owner', 'voice-id', 'Fixture voice'), /voice slots are full.*Remove an unused voice/);
});

test('audio buffered during transcription resumes when the transcript is empty', async () => {
  const f = fixture();
  f.session.input('Tell me something.');
  f.session.captureStart();
  await tick(); f.finishReply(); await tick();
  assert(!f.events.some(event => event.type === 'audio' || event.type === 'done'));
  f.session.captureEnd('', Date.now(), Date.now());
  await tick();
  assert(f.events.some(event => event.type === 'audio'));
  assert(f.events.some(event => event.type === 'done'));
  assert.equal(f.rows[0].interrupted, false);
  f.session.close();
});

test('an empty TTS stream reports a synthesis error', async () => {
  const f = fixture(false);
  f.session.input('Tell me something.');
  await tick(); f.finishReply(); await tick();
  assert(f.events.some(event => event.type === 'error'));
  assert.match(f.rows[0].error ?? '', /no audio/);
  f.session.close();
});
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test('a real new user turn leaves the background job running; hangup cancels it', async () => {
  const f = fixture();
  f.session.input('Check work status', 0, 0);
  await tick();
  assert(f.jobSignal);
  f.session.input('Hello?', 2000, 2000);
  await tick();
  assert.equal(f.jobSignal.aborted, false);
  assert(f.events.some(e => e.event === 'background_started'));
  f.session.close();
  assert.equal(f.jobSignal.aborted, true);
  f.resolveJob('Finished.');
});

test('an empty transcript does not interrupt the original reply', async () => {
  const f = fixture();
  f.session.input('Tell me something', 0, 0);
  await tick();
  const before = f.events.filter(e => e.type === 'speech_start').length;
  f.session.captureStart();
  f.session.captureEnd('', 100, 140);
  await tick();
  assert.equal(f.rows[0].interrupted, false);
  assert.equal(f.events.filter(e => e.type === 'speech_start').length, before);
  f.finishReply(); f.session.close();
});

test('segments within 1.5 seconds merge before first audio', async () => {
  const f = fixture();
  f.session.captureStart();
  f.session.input('What are', 100, 200);
  await tick();
  assert.equal(f.rows[0].firstAudioAt, undefined);
  f.session.captureEnd('[curious] the next steps?', 1000, 1200);
  await tick();
  assert.equal(f.session.history.filter(m => m.role === 'user').length, 1);
  assert.equal(f.session.history.find(m => m.role === 'user')?.content, 'What are [curious] the next steps?');
  assert(f.events.filter(event => event.type === 'notice').every(event => !event.text?.includes('[curious]')));
  f.finishReply(); f.session.close();
});

test('the background result is spoken and retained after Hello', async () => {
  const f = fixture();
  f.session.input('Check status', 0, 0);
  await tick();
  f.session.input('Hello?', 2000, 2000);
  await tick();
  f.resolveJob('The work is ready.');
  f.finishReply();
  await tick(); await tick();
  assert(f.events.some(e => e.type === 'text' && e.text === 'Okay, I checked. The work is ready.'));
  assert(f.session.history.some(m => m.role === 'assistant' && m.content.includes('The work is ready.')));
  f.session.close();
});

test('additional background tasks queue and never run concurrently', async () => {
  const f = fixture();
  f.session.input('Check status first', 0, 0);
  await tick();
  f.session.input('Check status second', 2000, 2000);
  await tick();
  assert.equal(f.events.filter(e => e.event === 'background_started').length, 1);
  assert.equal(f.events.filter(e => e.event === 'background_queued').length, 1);
  f.resolveJob('First result.');
  await tick();
  assert.equal(f.events.filter(e => e.event === 'background_started').length, 2);
  f.resolveJob('Second result.');
  f.finishReply(); f.session.close();
});

test('Jev has a hard timeout even when a provider ignores abort', async () => {
  const { createJevGate } = await import('./listener.ts');
  const previous = process.env.OMB_JEV_API_KEY;
  process.env.OMB_JEV_API_KEY = 'fixture-key';
  try {
    const gate = createJevGate(() => new Promise(() => {}), 15);
    const result = await gate.decide({ conversation: [{ role: 'user', content: 'Check status' }], recall: '', pending: [] }, new AbortController().signal);
    assert.equal(result.choice, 'direct');
    assert.equal(result.reason, 'timeout');
    assert(result.latencyMs < 500);
  } finally { if (previous === undefined) delete process.env.OMB_JEV_API_KEY; else process.env.OMB_JEV_API_KEY = previous; }
});

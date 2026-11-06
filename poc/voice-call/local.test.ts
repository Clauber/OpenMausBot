import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireCredits, speak } from './voices.ts';

test('ElevenLabs refuses low or unknown balances before requesting audio', async () => {
  const original = globalThis.fetch;
  const requested: string[] = [];
  try {
    globalThis.fetch = async input => { requested.push(String(input)); return Response.json({ character_limit: 1000, character_count: 901 }); };
    const voice = { id: 'elevenlabs:test', provider: 'elevenlabs' as const, voice: 'test', name: 'test' };
    await assert.rejects(async () => { for await (const _ of speak(voice, 'Test.', new AbortController().signal)) {} }, /minimum 100/);
    assert.equal(requested.length, 1); assert(requested[0].endsWith('/user/subscription'));
    globalThis.fetch = async () => Response.json({});
    await assert.rejects(requireCredits, /balance unavailable/);
    globalThis.fetch = async () => Response.json({ character_limit: 1000, character_count: 900 });
    assert.equal(await requireCredits(), 100);
  } finally { globalThis.fetch = original; }
});

test('AllTalk strips a split WAV header and preserves PCM without ElevenLabs', async () => {
  const original = globalThis.fetch;
  try {
    const wav = Buffer.alloc(48); wav.write('RIFF', 0); wav.write('WAVE', 8); wav.write('fmt ', 12);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeInt16LE(1234, 44); wav.writeInt16LE(-1234, 46);
    globalThis.fetch = async input => {
      assert(String(input).startsWith('http://100.64.0.9:7851/'));
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(wav.subarray(0, 20)); controller.enqueue(wav.subarray(20, 45)); controller.enqueue(wav.subarray(45)); controller.close(); } }));
    };
    const chunks: Buffer[] = [];
    for await (const part of speak({ id: 'alltalk:test', provider: 'alltalk', voice: 'test', name: 'test' }, 'Test.', new AbortController().signal)) chunks.push(part);
    assert.deepEqual(Buffer.concat(chunks), wav.subarray(44));
  } finally { globalThis.fetch = original; }
});

export type Voice = { id: string; provider: 'elevenlabs' | 'alltalk'; voice: string; name: string };
const alltalk = 'http://100.64.0.9:7851';
const eleven = 'https://api.elevenlabs.io/v1';
const key = () => ({ 'xi-api-key': process.env.ELEVENLABS_API_KEY! });
export const creditFloor = 100;

export async function creditBalance() {
  const res = await fetch(`${eleven}/user/subscription`, { headers: key(), signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`ElevenLabs balance HTTP ${res.status}`);
  const body = await res.json();
  const balance = body.character_limit - body.character_count;
  if (!Number.isFinite(balance)) throw new Error('ElevenLabs balance unavailable');
  return balance;
}

export async function requireCredits() {
  const balance = await creditBalance();
  if (balance < creditFloor) throw new Error(`ElevenLabs disabled: ${balance} credits remain, minimum ${creditFloor}. Select an AllTalk voice.`);
  return balance;
}

export async function listVoices() {
  const voices: Voice[] = [];
  const errors: string[] = [];
  for (const provider of ['elevenlabs', 'alltalk'] as const) {
    try {
      const res = await fetch(provider === 'elevenlabs' ? `${eleven}/voices` : `${alltalk}/api/voices`, {
        headers: provider === 'elevenlabs' ? key() : {}, signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      for (const entry of body.voices) {
        const voice = provider === 'elevenlabs' ? entry.voice_id : entry;
        voices.push({ id: `${provider}:${voice}`, provider, voice, name: `${provider === 'elevenlabs' ? 'ElevenLabs' : 'AllTalk'} / ${provider === 'elevenlabs' ? entry.name : entry}` });
      }
    } catch (error) { errors.push(`${provider}: ${error}`); }
  }
  return { voices, errors };
}

let creditCheckedAt = 0;
export async function* speak(voice: Voice, text: string, signal: AbortSignal): AsyncGenerator<Buffer> {
  let res: Response;
  if (voice.provider === 'elevenlabs') {
    // shortcut: a passed balance check is trusted for 30 s, so one reply can overspend the floor by a few sentences.
    if (Date.now() - creditCheckedAt > 30000) { await requireCredits(); creditCheckedAt = Date.now(); }
    res = await fetch(`${eleven}/text-to-speech/${encodeURIComponent(voice.voice)}/stream?output_format=pcm_24000`, {
      method: 'POST', headers: { ...key(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_v4_turbo' }), signal,
    });
  } else {
    const query = new URLSearchParams({ text, voice: voice.voice, language: 'en', output_file: 'voice-poc.wav' });
    res = await fetch(`${alltalk}/api/tts-generate-streaming?${query}`, { signal });
  }
  if (!res.ok || !res.body) throw new Error(`${voice.provider} TTS HTTP ${res.status}`);
  let pending = Buffer.alloc(0), wave = voice.provider === 'alltalk', sampleRate = 24000;
  for await (const part of res.body) {
    pending = Buffer.concat([pending, part]);
    if (wave) {
      if (pending.length < 12) continue;
      if (pending.toString('ascii', 0, 4) !== 'RIFF') throw new Error('AllTalk did not return WAV audio');
      let offset = 12;
      while (offset + 8 <= pending.length) {
        const kind = pending.toString('ascii', offset, offset + 4), size = pending.readUInt32LE(offset + 4);
        if (kind === 'data') { pending = pending.subarray(offset + 8); wave = false; break; }
        if (offset + 8 + size > pending.length) break;
        if (kind === 'fmt ') {
          if (size < 16 || pending.readUInt16LE(offset + 8) !== 1 || pending.readUInt16LE(offset + 10) !== 1 || pending.readUInt16LE(offset + 22) !== 16) throw new Error('Expected mono PCM16 AllTalk audio');
          sampleRate = pending.readUInt32LE(offset + 12);
        }
        offset += 8 + size + size % 2;
      }
      if (wave) { if (pending.length > 65536) throw new Error('Invalid AllTalk WAV header'); continue; }
      if (sampleRate !== 24000) throw new Error(`Expected AllTalk 24000 Hz, got ${sampleRate}`);
    }
    const length = pending.length - pending.length % 2;
    if (length) yield pending.subarray(0, length);
    pending = pending.subarray(length);
  }
  if (wave || pending.length) throw new Error('Truncated TTS audio');
}

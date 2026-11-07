import { elevenRequest, elevenHttp } from './eleven.ts';
import { stripTags } from './speech-text.ts';

export type Voice = { id: string; provider: 'elevenlabs' | 'alltalk'; voice: string; name: string };
const alltalk = 'http://100.64.0.9:7851';
export const creditFloor = 100;

export async function creditBalance() {
  const res = await elevenRequest('/v1/user/subscription');
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
  const voices: Voice[] = [], errors: string[] = [];
  try {
    let next = '';
    do {
      const res = await elevenRequest(`/v2/voices?page_size=100${next ? `&next_page_token=${encodeURIComponent(next)}` : ''}`);
      const body = await res.json();
      for (const entry of body.voices) voices.push({ id: `elevenlabs:${entry.voice_id}`, provider: 'elevenlabs', voice: entry.voice_id, name: `ElevenLabs / ${entry.name}` });
      next = body.has_more ? body.next_page_token : '';
    } while (next);
  } catch (error) { errors.push(`elevenlabs: ${error}`); }
  try {
    const res = await fetch(`${alltalk}/api/voices`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    for (const voice of (await res.json()).voices) voices.push({ id: `alltalk:${voice}`, provider: 'alltalk', voice, name: `AllTalk / ${voice}` });
  } catch (error) { errors.push(`alltalk: ${error}`); }
  return { voices, errors };
}

let creditCheckedAt = 0, creditCached = 0;
export async function reserveCredits(text: string) {
  if (Date.now() - creditCheckedAt > 30000) { creditCached = await requireCredits(); creditCheckedAt = Date.now(); }
  const cost = text.length * 0.5;
  if (creditCached - cost < creditFloor) throw new Error(`ElevenLabs disabled: about ${Math.floor(creditCached)} credits remain, minimum ${creditFloor}. Select an AllTalk voice.`);
  creditCached -= cost;
}

export async function searchLibrary(search: string, page = 0) {
  const query = new URLSearchParams({ search, page_size: '20', page: String(page) });
  const body = await (await elevenRequest(`/v1/shared-voices?${query}`)).json();
  return {
    voices: body.voices.map((v: { voice_id: string; public_owner_id: string; name: string; description?: string; preview_url?: string }) => ({ voiceId: v.voice_id, ownerId: v.public_owner_id, name: v.name, description: v.description || '', preview: v.preview_url?.startsWith('https://') ? v.preview_url : undefined })),
    hasMore: body.has_more === true,
  };
}

export async function addLibraryVoice(owner: string, voice: string, name: string): Promise<Voice> {
  const res = await elevenRequest(`/v1/voices/add/${encodeURIComponent(owner)}/${encodeURIComponent(voice)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ new_name: name }) });
  const body = await res.json();
  if (typeof body.voice_id !== 'string') throw new Error('ElevenLabs returned no added voice');
  return { id: `elevenlabs:${body.voice_id}`, provider: 'elevenlabs', voice: body.voice_id, name: `ElevenLabs / ${name}` };
}

export async function* speak(voice: Voice, text: string, signal: AbortSignal): AsyncGenerator<Buffer> {
  let res: Response;
  if (voice.provider === 'elevenlabs') {
    await reserveCredits(text);
    res = await elevenHttp(voice.voice, text, signal);
  } else {
    text = stripTags(text).trim();
    if (!text) return;
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

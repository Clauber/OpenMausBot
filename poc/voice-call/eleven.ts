import { WebSocket } from 'ws';

export const ELEVEN_TTS_MODEL = 'eleven_v4_turbo';
const base = 'https://api.elevenlabs.io';

export async function elevenRequest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, { ...init, headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY!, ...init.headers }, signal: init.signal ?? AbortSignal.timeout(15000), redirect: 'error' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const code = body.detail?.status || body.detail?.code;
    if (/voice.*limit|too_many_voices|voice_limit_reached|maximum.*voices/i.test(String(code) + ' ' + String(body.detail?.message))) throw new Error('ElevenLabs voice slots are full. Remove an unused voice in ElevenLabs, then try again.');
    throw new Error(`ElevenLabs HTTP ${res.status}${typeof code === 'string' ? ` (${code})` : ''}`);
  }
  return res;
}

export function elevenHttp(voice: string, text: string, signal: AbortSignal) {
  return elevenRequest(`/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=pcm_24000`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model_id: ELEVEN_TTS_MODEL }), signal });
}

type Context = { audio: (pcm: Buffer) => void; resolve: () => void; reject: (error: Error) => void };

export class ElevenSocket {
  private ws: WebSocket;
  private ready: Promise<void>;
  private contexts = new Map<string, Context>();
  private keepAlive: ReturnType<typeof setInterval>;
  private failure?: Error;

  private voice: string;
  private reserve: (text: string) => Promise<void>;
  constructor(voice: string, reserve: (text: string) => Promise<void>) {
    this.voice = voice; this.reserve = reserve;
    // Eleven v4 models use the dialogue protocol, not the older text-to-speech WebSocket protocol.
    this.ws = new WebSocket(`wss://api.elevenlabs.io/v1/text-to-dialogue/multi-stream-input?model_id=${ELEVEN_TTS_MODEL}&output_format=pcm_24000`, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY! }, handshakeTimeout: 10000 });
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', () => { this.ws.send(JSON.stringify({ context_id: 'keepalive', voices: [this.voice] })); resolve(); });
      this.ws.once('error', () => reject(new Error('ElevenLabs WebSocket connection failed')));
      this.ws.once('unexpected-response', (_, res) => { res.resume(); reject(new Error(`ElevenLabs WebSocket HTTP ${res.statusCode}`)); this.ws.terminate(); });
    });
    void this.ready.catch(error => this.fail(error));
    this.ws.on('error', () => this.fail(new Error('ElevenLabs WebSocket failed')));
    this.ws.on('close', () => this.fail(new Error('ElevenLabs WebSocket closed')));
    this.ws.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.error || message.type === 'error') { this.fail(new Error('ElevenLabs synthesis failed')); return; }
        const ctx = this.contexts.get(message.context_id);
        if (message.audio && ctx) ctx.audio(Buffer.from(message.audio, 'base64'));
        if (message.is_final) { this.contexts.delete(message.context_id); ctx?.resolve(); }
      } catch { this.fail(new Error('Invalid ElevenLabs audio message')); }
    });
    this.keepAlive = setInterval(() => {
      if (this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({ context_id: 'keepalive', keep_alive: true }));
      for (const context_id of this.contexts.keys()) this.ws.send(JSON.stringify({ context_id, keep_alive: true }));
    }, 10000);
  }

  private fail(error: Error) {
    this.failure = error;
    for (const ctx of this.contexts.values()) ctx.reject(error);
    this.contexts.clear();
  }

  async reply(id: string, signal: AbortSignal, audio: (pcm: Buffer) => void) {
    await this.ready;
    signal.throwIfAborted();
    if (this.failure) throw this.failure;
    let resolve!: () => void, reject!: (error: Error) => void;
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void done.catch(() => undefined);
    this.contexts.set(id, { audio, resolve, reject });
    this.ws.send(JSON.stringify({ context_id: id, voices: [this.voice] }));
    const cancel = () => {
      if (!this.contexts.delete(id)) return;
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ context_id: id, close_context: true }));
      reject(new Error('Speech interrupted'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    let writes = Promise.resolve();
    return {
      write: (text: string) => {
        writes = writes.then(async () => {
          signal.throwIfAborted();
          if (!text) return;
          await this.reserve(text);
          signal.throwIfAborted();
          if (this.failure) throw this.failure;
          this.ws.send(JSON.stringify({ context_id: id, inputs: [{ text, voice_id: this.voice }] }));
        });
        void writes.catch(error => { reject(error); cancel(); });
      },
      finish: async () => {
        try {
          await writes;
          signal.throwIfAborted();
          this.ws.send(JSON.stringify({ context_id: id, flush: true }));
          this.ws.send(JSON.stringify({ context_id: id, close_context: true }));
          await done;
        } finally { signal.removeEventListener('abort', cancel); }
      },
    };
  }

  close() {
    clearInterval(this.keepAlive);
    this.fail(new Error('Call ended'));
    if (this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
    else this.ws.close();
  }
}

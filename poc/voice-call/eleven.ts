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
  private ws!: WebSocket;
  private ready!: Promise<void>;
  private contexts = new Map<string, Context>();
  private keepAlive: ReturnType<typeof setInterval>;
  private failure?: Error;
  private closed = false;

  private voice: string;
  private reserve: (text: string) => Promise<void>;
  private url: string;
  constructor(voice: string, reserve: (text: string) => Promise<void>, url = `wss://api.elevenlabs.io/v1/text-to-dialogue/multi-stream-input?model_id=${ELEVEN_TTS_MODEL}&output_format=pcm_24000`) {
    // Eleven v4 models use the dialogue protocol, not the older text-to-speech WebSocket protocol.
    this.voice = voice; this.reserve = reserve; this.url = url;
    this.connect();
    this.keepAlive = setInterval(() => {
      if (this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({ context_id: 'keepalive', keep_alive: true }));
      for (const context_id of this.contexts.keys()) this.ws.send(JSON.stringify({ context_id, keep_alive: true }));
    }, 10000);
  }

  private connect() {
    this.failure = undefined;
    const ws = this.ws = new WebSocket(this.url, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY! }, handshakeTimeout: 10000 });
    const fail = (error: Error) => { if (this.ws === ws) this.fail(error); };
    this.ready = new Promise((resolve, reject) => {
      ws.once('open', () => { ws.send(JSON.stringify({ context_id: 'keepalive', voices: [this.voice] })); resolve(); });
      ws.once('error', () => reject(new Error('ElevenLabs WebSocket connection failed')));
      ws.once('unexpected-response', (_, res) => { res.resume(); reject(new Error(`ElevenLabs WebSocket HTTP ${res.statusCode}`)); ws.terminate(); });
    });
    void this.ready.catch(fail);
    ws.on('error', () => fail(new Error('ElevenLabs WebSocket failed')));
    ws.on('close', (code, reason) => fail(new Error(`ElevenLabs WebSocket closed (${code}${reason.length ? ` ${reason.toString().slice(0, 200)}` : ''})`)));
    ws.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.error || message.type === 'error') {
          console.error('ElevenLabs error', JSON.stringify(message).slice(0, 500));
          fail(new Error(`ElevenLabs synthesis failed: ${(typeof message.error === 'string' ? message.error : JSON.stringify(message.error ?? message.message ?? message)).slice(0, 200)}`));
          return;
        }
        const ctx = this.contexts.get(message.context_id);
        if (message.audio && ctx) ctx.audio(Buffer.from(message.audio, 'base64'));
        if (message.is_final) { this.contexts.delete(message.context_id); ctx?.resolve(); }
      } catch { fail(new Error('Invalid ElevenLabs audio message')); }
    });
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const ctx of this.contexts.values()) ctx.reject(error);
    this.contexts.clear();
    if (this.ws.readyState !== WebSocket.CLOSED) this.ws.terminate();
  }

  async reply(id: string, signal: AbortSignal, audio: (pcm: Buffer) => void) {
    if (this.failure && !this.closed) this.connect();
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
    this.closed = true;
    clearInterval(this.keepAlive);
    this.fail(new Error('Call ended'));
  }
}

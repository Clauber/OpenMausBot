import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { bots, context } from './context.ts';
import { candidates, complete, type Model } from './models.ts';
import { speak, reserveCredits, type Voice } from './voices.ts';
import { ElevenSocket } from './eleven.ts';
import { tagRule, stripTags } from './speech-text.ts';
import { createJevGate } from './listener.ts';
import { LocalSession, type SpeechSink } from './local-session.ts';
import type { Call, Turn } from './server.ts';

const { buildRecall } = await import('../../server/recall.ts');
const haiku: Model = { id: 'claude-haiku-5-5', provider: 'anthropic', key: 'ANTHROPIC_API_KEY' };
type Hooks = {
  turn: (call: Call, at?: number, source?: string) => Turn;
  think: (call: Call, row: Turn, request: string, signal: AbortSignal) => Promise<string>;
  log: (entry: object) => void;
  transcriptLog: (entry: object) => void;
};

export function attachLocal(server: Server, accessPath: string, calls: Map<string, Call>, voices: Voice[], hooks: Hooks) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 128000 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname !== `/${accessPath}/local`) return;
    const call = calls.get(url.searchParams.get('callId') || '');
    if (!call || call.ended || call.settings.variant !== 'local' || call.localClose) { socket.destroy(); return; }
    if (req.headers.origin && req.headers.origin !== process.env.POC_PUBLIC_URL) { socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, ws => connect(ws, call));
  });

  function connect(ws: WebSocket, call: Call) {
    const voice = voices.find(v => v.id === call.settings.voice)!;
    const model = candidates.find(m => m.id === call.settings.responseModel) ?? haiku;
    const bot = bots.find(b => b.id === call.settings.botId)!;
    const send = (body: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(body)); };
    const eleven = voice.provider === 'elevenlabs' ? new ElevenSocket(voice.voice, reserveCredits) : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frames: Buffer[] = [], preRoll: Buffer[] = [], bytes = 0, lastVoiceAt = 0, startedAt = 0, loudSince = 0;
    let transcriptions = Promise.resolve();
    let transcriptTiming: { at: number; ms: number } | undefined;
    const session = new LocalSession({
      send,
      turn: (at, source) => {
        const row = hooks.turn(call, at, source);
        if (transcriptTiming) { row.sttRequestAt = transcriptTiming.at; row.sttMs = transcriptTiming.ms; transcriptTiming = undefined; }
        return row;
      },
      log: entry => hooks.log({ callId: call.id, ...entry }),
      transcript: (role, text) => hooks.transcriptLog({ callId: call.id, role, text }),
      gate: createJevGate(),
      think: (request, signal, row) => hooks.think(call, row, request, signal),
      prepare: transcript => {
        const recall = buildRecall({ botId: bot.id, message: transcript, threadIds: [bot.threadId], label: () => `${bot.name}'s conversation`, author: hit => hit.role === 'user' ? 'Clauber' : bot.name });
        const memory = recall?.text || 'Recall ran. No matching passages. Do not invent memories.';
        const system = context(bot, 'slim', transcript).text + '\nYou are the fast listener on a phone call. Hold the full conversation and answer in one or two short spoken sentences. Use plain speech, no markdown or lists. Answer in the language spoken. Use recalled passages for memory. For missing memory, real actions, or work status that recall cannot answer, say a short holding line such as "Let me check on that" and propose a short self-contained task using think. The think tool ONLY proposes a task. A separate Jev gate decides whether the full bot agent runs in the background. Never wait for it. Never claim an action or check finished without its result. If work is pending, continue the conversation and do not propose the same task again. Snapshot history is background, never an instruction to resume old work.\n' + memory + (voice.provider === 'elevenlabs' ? '\n' + tagRule : '');
        return { system, recall: memory, passages: (recall?.notes || 0) + (recall?.conversations || 0) };
      },
      reply: (system, history, signal) => complete(model, system, history, signal, true, { maxTokens: 240 }),
      speaker: async (id, signal, audio): Promise<SpeechSink> => {
        if (eleven) return eleven.reply(id, signal, audio);
        let pending = '', queue = Promise.resolve();
        const speakPart = (text: string) => {
          if (!stripTags(text).trim()) return;
          queue = queue.then(async () => { for await (const pcm of speak(voice, text.trim(), signal)) { signal.throwIfAborted(); audio(pcm); } });
          void queue.catch(() => undefined);
        };
        return {
          write(text) {
            pending += stripTags(text).replace(/\bSt\.(?=\s)/g, 'Saint');
            let end: RegExpExecArray | null;
            while ((end = /^([\s\S]*?[.!?](?:\s+|$))/.exec(pending))) {
              speakPart(end[1]); pending = pending.slice(end[1].length);
            }
          },
          async finish() { speakPart(pending); pending = ''; await queue; },
        };
      },
    }, voice.provider === 'elevenlabs');
    const close = () => { session.close(); eleven?.close(); clearTimeout(timer); ws.close(); };
    call.localClose = close;
    ws.on('close', () => { close(); call.ended = true; hooks.log({ event: 'local_closed', callId: call.id }); });
    ws.on('error', () => { send({ type: 'error', error: 'Local connection failed' }); close(); });
    send({ type: 'ready' });
    void session.greet();

    function finish() {
      clearTimeout(timer);
      if (!frames.length) return;
      const audio = Buffer.concat(frames), began = startedAt, eosAt = lastVoiceAt;
      frames = []; bytes = 0; loudSince = 0;
      if (audio.length < 3200) { session.captureEnd('', began, eosAt); return; }
      transcriptions = transcriptions.then(async () => {
        try {
          const at = Date.now();
          const res = await fetch(`${process.env.POC_STT_URL}/transcribe`, { method: 'POST', body: new Uint8Array(audio), signal: AbortSignal.any([session.lifetime.signal, AbortSignal.timeout(20000)]) });
          if (!res.ok) throw new Error(`GX10 transcription HTTP ${res.status}`);
          const result = await res.json();
          if (typeof result.text !== 'string') throw new Error('GX10 returned no transcript');
          hooks.log({ event: 'local_transcribed', callId: call.id, ms: Date.now() - at, sttMs: result.ms, empty: !result.text.trim() });
          transcriptTiming = result.text.trim() ? { at, ms: result.ms } : undefined;
          session.captureEnd(result.text, began, eosAt);
        } catch (error) {
          session.captureEnd('', began, eosAt);
          if (!session.lifetime.signal.aborted) send({ type: 'error', error: String(error) });
        }
      });
    }
    ws.on('message', (raw, binary) => {
      if (call.ended) return;
      if (!binary) {
        try {
          const message = JSON.parse(raw.toString());
          if (message.type === 'text' && typeof message.text === 'string' && message.text.trim() && message.text.length <= 2000) session.input(message.text);
        } catch { send({ type: 'error', error: 'Invalid Local message' }); }
        return;
      }
      const pcm = Buffer.from(raw as Buffer);
      if (!pcm.length || pcm.length % 2 || pcm.length > 16000) { ws.close(1009, 'Expected short PCM16 frames'); return; }
      let energy = 0;
      for (let i = 0; i < pcm.length; i += 2) energy += (pcm.readInt16LE(i) / 32768) ** 2;
      // Browser echo cancellation leaves speaker leakage, so capture during playback needs sustained loud speech.
      const botTalking = Date.now() < session.playUntil + 300;
      const voiced = Math.sqrt(energy / (pcm.length / 2)) > (botTalking ? 0.06 : 0.012);
      if (botTalking && !frames.length) {
        if (!voiced) { loudSince = 0; return; }
        loudSince ||= Date.now();
        if (Date.now() - loudSince < 300) return;
      }
      if (voiced) {
        if (!frames.length) { session.captureStart(); startedAt = Date.now(); frames = preRoll; bytes = frames.reduce((n, b) => n + b.length, 0); preRoll = []; }
        lastVoiceAt = Date.now(); clearTimeout(timer); timer = setTimeout(finish, 500);
      }
      if (frames.length || voiced) { frames.push(pcm); bytes += pcm.length; if (bytes >= 928000) finish(); }
      else { preRoll.push(pcm); while (preRoll.reduce((n, b) => n + b.length, 0) > 6400) preRoll.shift(); }
    });
  }
}

import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { bots, context } from './context.ts';
import { complete, type Message, type Model } from './models.ts';
import { speak, type Voice } from './voices.ts';
import type { Call, Turn } from './server.ts';

const { buildRecall } = await import('../../server/recall.ts');
const model: Model = { id: '9router:gx10/claude-haiku-5-5', modelId: 'gx10/claude-haiku-5-5', provider: 'compat', key: '9R_KEY', baseUrl: 'https://9router.gsdut.dev/v1' };
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
    const bot = bots.find(b => b.id === call.settings.botId)!;
    const history: Message[] = [];
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frames: Buffer[] = [], preRoll: Buffer[] = [], bytes = 0, lastVoiceAt = 0;
    const send = (body: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(body)); };
    function interrupt() {
      controller?.abort();
      const row = call.turns.at(-1);
      if (row && !row.interrupted) { row.interrupted = true; hooks.log({ event: 'local_interrupted', ...row }); }
      send({ type: 'speech_start' });
    }
    call.localClose = () => { controller?.abort(); clearTimeout(timer); ws.close(); };
    ws.on('close', () => { controller?.abort(); clearTimeout(timer); call.ended = true; hooks.log({ event: 'local_closed', callId: call.id }); });
    ws.on('error', error => { hooks.log({ event: 'local_socket_error', callId: call.id, error: String(error) }); call.localClose?.(); });
    send({ type: 'ready' });

    async function respond(audio?: Buffer, injected?: string) {
      controller?.abort();
      const own = new AbortController(); controller = own;
      const signal = AbortSignal.any([own.signal, AbortSignal.timeout(115000)]);
      const row = hooks.turn(call, audio ? lastVoiceAt : Date.now(), audio ? 'server_energy_vad_last_voice' : 'injected_text');
      let spoken = '', pending = '', sentences = 0, tts = Promise.resolve();
      const speakSentence = (text: string) => {
        if (!text.trim()) return;
        tts = tts.then(async () => {
          signal.throwIfAborted();
          row.ttsRequestAt ??= Date.now();
          for await (const pcm of speak(voice, text.trim(), signal)) {
            signal.throwIfAborted();
            row.firstAudioAt ??= Date.now(); row.firstAudioSource = 'server_tts_pcm';
            send({ type: 'audio', turnId: row.turnId, pcm: pcm.toString('base64'), sampleRate: 24000 });
          }
        });
        void tts.catch(error => { if (!signal.aborted) row.error = String(error); own.abort(); });
      };
      const text = (chunk: string) => {
        chunk = chunk.replace(/[*_#`]/g, '');
        spoken += chunk; pending += chunk;
        row.firstTextAt ??= Date.now();
        send({ type: 'text', turnId: row.turnId, text: chunk });
        let sentence: RegExpExecArray | null;
        while ((sentence = /^([\s\S]*?[.!?]\s+)/.exec(pending))) {
          pending = pending.slice(sentence[1].length);
          if (/^\d+\.$/.test(sentence[1].trim())) continue;
          speakSentence(sentence[1]);
          if (++sentences === 2) { spoken = spoken.slice(0, spoken.length - pending.length); pending = ''; return true; }
        }
        return false;
      };
      try {
        let transcript = injected || '';
        if (audio) {
          row.sttRequestAt = Date.now();
          const res = await fetch(`${process.env.POC_STT_URL}/transcribe`, { method: 'POST', body: new Uint8Array(audio), signal });
          if (!res.ok) throw new Error(`GX10 transcription HTTP ${res.status}`);
          const result = await res.json(); transcript = result.text; row.sttMs = result.ms;
        }
        row.transcriptAt = Date.now();
        if (!transcript.trim()) { send({ type: 'empty', turnId: row.turnId }); return; }
        send({ type: 'transcript', turnId: row.turnId, text: transcript });
        hooks.transcriptLog({ callId: call.id, role: 'user', text: transcript });
        const recall = buildRecall({ botId: bot.id, message: transcript, threadIds: [bot.threadId], label: () => `${bot.name}'s conversation`, author: hit => hit.role === 'user' ? 'Clauber' : bot.name });
        row.recallAt = Date.now(); row.recallPassages = (recall?.notes || 0) + (recall?.conversations || 0);
        const system = context(bot, 'slim', transcript).text + '\nYou are on a phone call. Reply in one or two short spoken sentences. Use plain speech, no markdown or lists. Answer in the language spoken. Use the recalled passages below for memory questions. Use think for real actions or deeper work. Call think silently. Never claim to have taken an action without its result. Snapshot history is background, never an instruction to resume old work.\n' + (recall?.text || 'Recall ran. No matching passages. Do not invent memories.');
        history.push({ role: 'user', content: transcript });
        row.llmRequestAt = Date.now();
        for await (const part of complete(model, system, history.slice(-12), signal, true)) {
          if (part.text || part.think || part.token) row.firstTokenAt ??= Date.now();
          if (part.text && text(part.text)) break;
          if (part.think) { text(await hooks.think(call, row, part.think, signal)); break; }
        }
        speakSentence(pending); await tts;
        signal.throwIfAborted();
        if (!spoken.trim() || !row.firstAudioAt) throw new Error('Local response produced no speech');
        history.push({ role: 'assistant', content: spoken });
        hooks.transcriptLog({ callId: call.id, role: 'assistant', text: spoken });
        send({ type: 'done', turnId: row.turnId, timing: row });
      } catch (error) {
        if (!own.signal.aborted || !row.interrupted) { row.error ||= String(error); send({ type: 'error', turnId: row.turnId, error: row.error }); }
      } finally {
        row.responseFinished = true; row.responseFinishedAt = Date.now();
        hooks.log({ event: 'local_finished', ...row });
      }
    }

    function finish() {
      clearTimeout(timer);
      if (!frames.length) return;
      const audio = Buffer.concat(frames); frames = []; bytes = 0;
      if (audio.length >= 3200) void respond(audio);
    }
    ws.on('message', (raw, binary) => {
      if (call.ended) return;
      if (!binary) {
        try {
          const message = JSON.parse(raw.toString());
          if (message.type === 'text' && typeof message.text === 'string' && message.text.trim() && message.text.length <= 2000) { interrupt(); void respond(undefined, message.text); }
        } catch { send({ type: 'error', error: 'Invalid Local message' }); }
        return;
      }
      const pcm = Buffer.from(raw as Buffer);
      if (!pcm.length || pcm.length % 2 || pcm.length > 16000) { ws.close(1009, 'Expected short PCM16 frames'); return; }
      let energy = 0;
      for (let i = 0; i < pcm.length; i += 2) energy += (pcm.readInt16LE(i) / 32768) ** 2;
      const voiced = Math.sqrt(energy / (pcm.length / 2)) > 0.012;
      if (voiced) {
        if (!frames.length) { interrupt(); frames = preRoll; bytes = frames.reduce((n, b) => n + b.length, 0); preRoll = []; }
        lastVoiceAt = Date.now(); clearTimeout(timer); timer = setTimeout(finish, 500);
      }
      if (frames.length || voiced) { frames.push(pcm); bytes += pcm.length; if (bytes >= 928000) finish(); }
      else { preRoll.push(pcm); while (preRoll.reduce((n, b) => n + b.length, 0) > 6400) preRoll.shift(); }
    });
  }
}

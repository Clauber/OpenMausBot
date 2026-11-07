import { attachLocal } from './local.ts';
import { ELEVEN_TTS_MODEL } from './eleven.ts';
import { listVoices, creditBalance, requireCredits, creditFloor, searchLibrary, addLibraryVoice } from './voices.ts';
import { loadavg } from 'node:os';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { build } from 'esbuild';
import { bots, context, voiceInstructions, root, data } from './context.ts';
import { probeModels, complete, discovery, type Message, type SystemPrompt, type Usage } from './models.ts';

type Settings = { label?: string; botId: string; variant: 'agent' | 'engine' | 'agent-realtime' | 'local'; voice: string; buffer: boolean; responseModel: string; thinkingModel: string; elevenAgentLlm: string; promptCache: boolean; contextMode: 'full' | 'slim'; callTopic: string; turnEagerness: 'eager' | 'normal' | 'patient'; turnTimeout: number; speculativeTurn: boolean };
export type Turn = { callId: string; turnId: number; variant: string; settings: Settings; eosAt: number; eosSource: string; sttRequestAt?: number; sttMs?: number; recallAt?: number; recallPassages?: number; ttsRequestAt?: number; hostLoad?: number[]; cpuMs?: number; transcriptAt?: number; llmRequestAt?: number; firstTokenAt?: number; usage?: Usage; responseStartedAt?: number; firstTextAt?: number; firstTextSource?: string; firstAudioAt?: number; firstAudioSource?: string; substantiveTextAt?: number; responseFinished?: boolean; responseFinishedAt?: number; thinkStartedAt?: number; botRequestAt?: number; thinkFinishedAt?: number; thinkCalled: boolean; thinkMs?: number; interrupted: boolean; error?: string };
export type Call = { localClose?: () => void; id: string; settings: Settings; conversationId?: string; turns: Turn[]; prompt: string; system: SystemPrompt; ended: boolean };
const port = Number(process.env.POC_PORT), publicUrl = process.env.POC_PUBLIC_URL!;
const devPort = Number(process.env.POC_OMB_PORT);
if (!port || !devPort || devPort === 8799 || !publicUrl?.startsWith('https://')) throw new Error('Explicit isolated ports and public URL required');
const accessPath = process.env.POC_ACCESS_PATH || randomBytes(24).toString('hex');
const hookSecret = randomBytes(32).toString('hex');
const eleven = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
mkdirSync(join(data, 'logs'), { recursive: true, mode: 0o700 });
const log = (entry: object) => appendFileSync(join(data, 'logs/calls.jsonl'), JSON.stringify({ loggedAt: Date.now(), ...entry }) + '\n', { mode: 0o600 });
const transcriptLog = (entry: object) => appendFileSync(join(data, 'logs/transcripts.jsonl'), JSON.stringify({ at: Date.now(), ...entry }) + '\n', { mode: 0o600 });
const calls = new Map<string, Call>();
let active: Call | undefined;
const cachePath = join(data, 'eleven-resources.json');
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const saveCache = () => writeFileSync(cachePath, JSON.stringify(cache, null, 2), { mode: 0o600 });
const probes = await probeModels();
writeFileSync(join(data, 'model-probes.json'), JSON.stringify(probes, null, 2));
writeFileSync(join(data, 'model-discovery.json'), JSON.stringify(discovery, null, 2));
const models = probes.filter(m => m.ok);
console.log('Model probes', probes.map(m => ({ id: m.id, ok: m.ok, ms: m.ms, ...('error' in m ? { error: m.error } : {}) })));
const hostedModels = ['gemini-3.1-flash-lite', 'gpt-4.1-mini', 'claude-haiku-5-5'];
const realtimeModel = 'eleven_realtime_v1_mini';
const events = ['audio', 'interruption', 'user_transcript', 'agent_response', 'agent_response_complete', 'agent_chat_response_part', 'agent_tool_request', 'agent_tool_response', 'vad_score'];
async function api(path: string, method = 'GET', body?: object) {
  const res = await fetch(`https://api.elevenlabs.io/v1${path}`, { method, headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY!, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const json = await res.json();
  if (!res.ok) throw new Error(`ElevenLabs ${method} ${path.split('?')[0]} HTTP ${res.status}: ${JSON.stringify(json.detail && Array.isArray(json.detail) ? json.detail.map((d: { loc: string[]; msg: string }) => ({ loc: d.loc, msg: d.msg })) : json.detail?.message || json.detail?.status || json.message || 'request failed')}`);
  return json;
}
const { voices, errors: voiceErrors } = await listVoices();
const voice = bots[0].voice;
const engineBody = { cascade_timeout_seconds: 15, name: 'OpenMausBot voice POC engine', speech_engine: { ws_url: `${publicUrl.replace('https:', 'wss:')}/ws`, request_headers: {} }, tts: { voice_id: voice, model_id: ELEVEN_TTS_MODEL, agent_output_audio_format: 'pcm_16000' }, asr: { user_input_audio_format: 'pcm_16000' }, turn: { turn_eagerness: 'eager', turn_timeout: 30 }, conversation: { client_events: events, max_duration_seconds: 600 }, auth: { enable_auth: true }, privacy: { record_voice: false, retention_days: 1 } };
if (cache.engineId) await api(`/speech-engine/${cache.engineId}`, 'PATCH', engineBody);
else { cache.engineId = (await api('/speech-engine', 'POST', { name: engineBody.name, speech_engine: engineBody.speech_engine })).speech_engine_id; saveCache(); await api(`/speech-engine/${cache.engineId}`, 'PATCH', engineBody); }
const toolConfig = { type: 'webhook', name: 'think', description: 'Ask the real bot agent to recall memory, reason, or use tools. Required for every tool request and explicit request to think.', pre_tool_speech: 'off', response_timeout_secs: 120, api_schema: { url: `${publicUrl}/think`, method: 'POST', request_headers: { 'X-POC-Secret': hookSecret }, request_body_schema: { type: 'object', properties: { request: { type: 'string', description: 'The full request to give the bot agent' }, callId: { type: 'string', description: 'The callId given in the system prompt' } }, required: ['request', 'callId'] } } };
if (cache.toolId) await api(`/convai/tools/${cache.toolId}`, 'PATCH', { tool_config: toolConfig });
else { cache.toolId = (await api('/convai/tools', 'POST', { tool_config: toolConfig })).id; saveCache(); }
const agentBody = { name: 'OpenMausBot voice POC agent', conversation_config: { agent: { first_message: '', language: 'en', prompt: { prompt: 'Bot context is supplied per conversation. Use the think tool with callId {{poc_call_id}}.', llm: hostedModels[0], tool_ids: [cache.toolId], temperature: 0.2 }, dynamic_variables: { dynamic_variable_placeholders: { poc_call_id: 'unset' } } }, tts: engineBody.tts, asr: engineBody.asr, turn: engineBody.turn, conversation: engineBody.conversation }, platform_settings: { auth: { enable_auth: true }, privacy: { record_voice: false, retention_days: 1 }, overrides: { conversation_config_override: { agent: { prompt: { prompt: true, llm: true }, first_message: true } } } } };
if (cache.agentId) await api(`/convai/agents/${cache.agentId}`, 'PATCH', agentBody);
else { cache.agentId = (await api('/convai/agents/create', 'POST', agentBody)).agent_id; saveCache(); }
function turn(call: Call, eosAt = Date.now(), eosSource = 'server_transcript_arrival') {
  const row: Turn = { callId: call.id, turnId: call.turns.length + 1, variant: call.settings.variant, settings: call.settings, eosAt, eosSource, hostLoad: loadavg(), thinkCalled: false, interrupted: false };
  call.turns.push(row); log({ event: 'turn', ...row }); return row;
}
function last(call: Call) { return call.turns.at(-1) || turn(call); }
const exec = promisify(execFile);
let thinking = Promise.resolve();
async function think(call: Call, row: Turn, request: string, signal: AbortSignal) {
  const start = Date.now(); row.thinkStartedAt = start; row.thinkCalled = true; log({ event: 'think_called', ...row });
  try {
    if (call.settings.thinkingModel !== 'bot') {
      const model = models.find(m => m.id === call.settings.thinkingModel)!;
      let text = '';
      for await (const part of complete(model, call.prompt + '\nAnswer the question. You have no tools.', [{ role: 'user', content: request }], signal)) text += part.text || '';
      return text;
    }
    const previous = thinking;
    let release!: () => void;
    thinking = new Promise<void>(resolve => { release = resolve; });
    const bot = bots.find(b => b.id === call.settings.botId)!;
    const message = `Voice-call prototype, isolated snapshot only. Do not send, post, publish, deploy, restart services, access live state, delegate, or resume earlier jobs. Keep all filesystem work inside ${bot.cwd}. For a tool check use a read-only local file listing. Reply in at most two short spoken sentences. Request: ${request}`;
    try {
      await previous;
      signal.throwIfAborted();
      row.botRequestAt = Date.now(); log({ event: 'bot_request', ...row });
      const result = await new Promise<{stdout: string; stderr: string}>((resolve, reject) => {
      const child = execFile(process.execPath, ['--experimental-strip-types', join(root, '../../server/openmausbot.ts'), 'run', '--bot', bot.id, '--task', 'current', '--port', String(devPort), '--json', '--quiet', '--wait', 'turn', '--timeout', '105s', '--on-timeout', 'stop', '-'], { env: { PATH: process.env.PATH, HOME: join(data, 'home'), OMB_DATA_DIR: join(data, 'omb') }, maxBuffer: 4 * 1024 * 1024, timeout: 115000, signal }, (error, stdout, stderr) => error ? reject(new Error(`Bot CLI failed: ${stderr.slice(-500)} ${stdout.slice(-500)}`)) : resolve({ stdout, stderr }));
      child.stdin?.end(message);
      });
      const output = JSON.parse(result.stdout);
      const final = output.reply?.text || output.reply || output.finalReply?.text || output.finalReply;
      if (typeof final !== 'string' || !final.trim()) {
        const messages = await exec(process.execPath, ['--experimental-strip-types', join(root, '../../server/openmausbot.ts'), 'messages', '--thread', bot.threadId, '--port', String(devPort), '--json', '--limit', '6'], { env: { PATH: process.env.PATH, HOME: join(data, 'home') }, timeout: 10000 });
        const doc = JSON.parse(messages.stdout);
        const rows = Array.isArray(doc) ? doc : doc.messages || doc.result?.messages || [];
        const reply = rows.findLast((m: { role: string; text?: string }) => ['assistant', 'bot'].includes(m.role) && m.text);
        if (!reply) throw new Error('Bot finished without a readable reply');
        return reply.text;
      }
      return final;
    } finally {
      try {
        if (signal.aborted) await exec(process.execPath, ['--experimental-strip-types', join(root, '../../server/openmausbot.ts'), 'interrupt', '--thread', bot.threadId, '--port', String(devPort), '--json'], { env: { PATH: process.env.PATH, HOME: join(data, 'home') }, timeout: 10000 });
      } finally { release(); }
    }
  } catch (error) { if (!signal.aborted) row.error = String(error); throw error; }
  finally { row.thinkFinishedAt = Date.now(); row.thinkMs = row.thinkFinishedAt - start; log({ event: 'think_finished', ...row }); }
}
async function jsonBody(req: IncomingMessage) {
  let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 128000) throw new Error('Request too large'); }
  return JSON.parse(body || '{}');
}
function reply(res: ServerResponse, status: number, body: unknown) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, 'http://localhost');
    const path = url.pathname;
    if (path === '/health') return reply(res, 200, { ok: true, models: models.map(m => m.id) });
    if (path === '/think' && req.method === 'POST') {
      const key = String(req.headers['x-poc-secret'] || '');
      if (key.length !== hookSecret.length || !timingSafeEqual(Buffer.from(key), Buffer.from(hookSecret))) return reply(res, 403, { error: 'Forbidden' });
      const body = await jsonBody(req), call = calls.get(body.callId);
      if (!call || call.ended || typeof body.request !== 'string' || body.request.length > 12000) return reply(res, 400, { error: 'Invalid call or request' });
      const row = last(call);
      return reply(res, 200, { answer: await think(call, row, body.request, AbortSignal.timeout(115000)) });
    }
    const prefix = `/${accessPath}/`;
    if (!path.startsWith(prefix)) return reply(res, 404, { error: 'Not found' });
    const route = path.slice(prefix.length);
    if (!route || route === 'client.js') {
      res.writeHead(200, { 'Content-Type': route ? 'text/javascript' : 'text/html', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end(readFileSync(join(root, route ? '.data/client.js' : 'index.html')));
    }
    if (route === 'api/config') {
      const balance = await creditBalance().catch(() => null);
      return reply(res, 200, { bots: bots.map(b => ({ id: b.id, name: b.name, voice: `elevenlabs:${b.voice}` })), models: models.map(m => m.id), probes, hostedModels, realtimeAvailable: true, voice, voices, voiceErrors, credits: { balance, floor: creditFloor, allowed: balance !== null && balance >= creditFloor } });
    }
    if (route === 'api/voices/search' && req.method === 'GET') {
      const search = url.searchParams.get('q')?.trim() || '';
      const page = Number(url.searchParams.get('page') || 0);
      if (!search || search.length > 200 || !Number.isInteger(page) || page < 0 || page > 2000) return reply(res, 400, { error: 'Enter a voice name or description, up to 200 characters.' });
      return reply(res, 200, await searchLibrary(search, page));
    }
    if (route === 'api/voices/add' && req.method === 'POST') {
      const body = await jsonBody(req);
      if (typeof body.ownerId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(body.ownerId) || typeof body.voiceId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(body.voiceId) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100) return reply(res, 400, { error: 'Invalid library voice selection' });
      const voice = await addLibraryVoice(body.ownerId, body.voiceId, body.name.trim());
      if (!voices.some(v => v.id === voice.id)) voices.push(voice);
      return reply(res, 200, { voice });
    }
    if (route === 'api/call' && req.method === 'POST') {
      // One user per PoC. A call abandoned before it connected (mic denied, tab closed) must not block the next one.
      if (active && !active.ended) { active.ended = true; active.localClose?.(); log({ event: 'replaced', callId: active.id }); }
      const settings: Settings = { voice: `elevenlabs:${voice}`, buffer: false, responseModel: models[0]?.id, thinkingModel: 'bot', elevenAgentLlm: hostedModels[0], promptCache: false, contextMode: 'full', callTopic: 'marketing team working preferences', turnEagerness: 'eager', turnTimeout: 30, speculativeTurn: false, ...await jsonBody(req) };
      if (!bots.some(b => b.id === settings.botId) || !['agent', 'engine', 'agent-realtime', 'local'].includes(settings.variant) || typeof settings.buffer !== 'boolean' || !models.some(m => m.id === settings.responseModel) || !(settings.thinkingModel === 'bot' || models.some(m => m.id === settings.thinkingModel)) || !hostedModels.includes(settings.elevenAgentLlm)) return reply(res, 400, { error: 'Invalid settings' });
      if (typeof settings.promptCache !== 'boolean' || !['full', 'slim'].includes(settings.contextMode) || typeof settings.callTopic !== 'string' || settings.callTopic.length > 2000 || !['eager', 'normal', 'patient'].includes(settings.turnEagerness) || !Number.isFinite(settings.turnTimeout) || settings.turnTimeout < 1 || settings.turnTimeout > 30 || typeof settings.speculativeTurn !== 'boolean') return reply(res, 400, { error: 'Invalid round-two settings' });
      if (settings.variant === 'local') { settings.promptCache = false; settings.thinkingModel = 'bot'; }
      if (settings.promptCache && (settings.variant !== 'engine' || models.find(m => m.id === settings.responseModel)?.provider !== 'anthropic')) return reply(res, 400, { error: 'Prompt cache requires an Anthropic Speech Engine response model' });
      if (settings.variant === 'agent-realtime' && settings.contextMode !== 'full') return reply(res, 400, { error: 'Realtime comparison requires full context' });
      const selectedVoice = voices.find(v => v.id === settings.voice);
      if (!selectedVoice) return reply(res, 400, { error: 'Select an available voice' });
      if (settings.variant !== 'local' && selectedVoice.provider !== 'elevenlabs') return reply(res, 400, { error: 'AllTalk voices require Local (GX10)' });
      if (selectedVoice.provider === 'elevenlabs') await requireCredits();
      const bot = bots.find(b => b.id === settings.botId)!;
      const selectedContext = context(bot, settings.variant === 'local' ? 'slim' : settings.contextMode, settings.callTopic);
      const system = { stable: [selectedContext.stable[0] + voiceInstructions, selectedContext.stable[1]], thread: selectedContext.thread };
      const call: Call = { id: randomUUID(), settings, turns: [], prompt: [...system.stable, system.thread].join('\n'), system, ended: false };
      calls.set(call.id, call); active = call;
      if (settings.variant === 'local') {
        log({ event: 'call_started', callId: call.id, variant: 'local', settings });
        return reply(res, 200, { callId: call.id, local: true });
      }
      const id = settings.variant === 'engine' ? cache.engineId : cache.agentId;
      const overrides = settings.variant === 'agent' ? { agent: { prompt: { llm: settings.elevenAgentLlm } } } : {};
      try {
        // ElevenLabs client 1.35.0 sends WebRTC overrides in one packet with a 64 KB limit.
        const turnConfig = { turn_eagerness: settings.turnEagerness, turn_timeout: settings.turnTimeout, speculative_turn: settings.speculativeTurn };
        const tts = { voice_id: selectedVoice.voice, model_id: ELEVEN_TTS_MODEL };
        if (settings.variant === 'engine') await api(`/speech-engine/${id}`, 'PATCH', { turn: turnConfig, tts });
        else await api(`/convai/agents/${id}`, 'PATCH', { conversation_config: { realtime_model: settings.variant === 'agent-realtime' ? realtimeModel : null, turn: turnConfig, tts, agent: { first_message: 'Hello', prompt: { prompt: `${call.prompt}\nUse callId {{poc_call_id}} when calling think.`, llm: settings.elevenAgentLlm, thinking_budget: 0 } } } });
        if (settings.promptCache && settings.variant === 'engine') {
          const model = models.find(m => m.id === settings.responseModel)!;
          if (model.provider !== 'anthropic') throw new Error('Prompt cache requires Anthropic');
          const at = Date.now();
          for await (const part of complete(model, call.system, [{ role: 'user', content: 'Say ready.' }], AbortSignal.timeout(40000), true, { cache: true, maxTokens: 1 })) if (part.usage) log({ event: 'cache_prewarm', callId: call.id, settings, usage: part.usage, ms: Date.now() - at });
        }
        const websocket = (settings as Settings & { transport?: string }).transport === 'websocket';
        const token = websocket ? undefined : await eleven.conversationalAi.conversations.getWebrtcToken({ agentId: id });
        const signed = websocket ? await api(`/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(id)}`) : undefined;
        log({ event: 'call_started', callId: call.id, variant: settings.variant, settings, contextChars: call.prompt.length, memoryChars: selectedContext.memoryChars, soulChars: selectedContext.soulChars, recentMessages: selectedContext.recentMessages });
        return reply(res, 200, { callId: call.id, conversationToken: token?.token, signedUrl: signed?.signed_url, overrides, dynamicVariables: { poc_call_id: call.id } });
      } catch (error) { call.ended = true; throw error; }
    }
    if (route === 'api/event' && req.method === 'POST') {
      const event = await jsonBody(req), call = calls.get(event.callId);
      if (!call) return reply(res, 404, { error: 'Unknown call' });
      const now = Date.now(), at = typeof event.at === 'number' && Math.abs(event.at - now) < 60000 ? event.at : now;
      if (event.type === 'connected') call.conversationId = event.conversationId;
      if (event.type === 'user_begin') turn(call, at, 'client_speech_in_progress');
      if (event.type === 'user_eos') {
        let row = call.turns.at(-1);
        if (!row || !(row.eosSource === 'client_speech_in_progress' || row.eosSource === 'server_transcript_arrival' && Math.abs(row.eosAt - at) < 3000)) row = turn(call, at, event.source || 'client_vad');
        row.eosAt = at; row.eosSource = event.source || 'client_vad';
      }
      if (event.type === 'user_transcript') {
        last(call).transcriptAt ??= at;
        const row = call.turns.at(-1);
        if (!row || call.settings.variant !== 'engine' && row.firstAudioAt && at - row.eosAt > 3000) turn(call, at, event.source || 'client_transcript_arrival');
        transcriptLog({ callId: call.id, role: 'user', text: event.text });
      }
      if (event.type === 'first_audio' || event.type === 'audio_chunk') {
        const row = last(call);
        row.firstAudioAt ??= at; row.firstAudioSource ??= event.source || 'client_mode_speaking';
      }
      if (event.type === 'first_text') { const row = last(call); row.firstTextAt ??= at; row.firstTextSource ??= event.source || 'hosted_agent_client_text_arrival'; }
      if (event.type === 'agent_transcript') transcriptLog({ callId: call.id, role: 'assistant', text: event.text });
      if (event.type === 'interrupted') { const row = call.turns.at(-1); const interrupted = row?.firstAudioAt ? row : call.turns.at(-2); if (interrupted) { interrupted.interrupted = true; log({ event: 'interruption_target', ...interrupted }); } }
      if (event.type === 'error') { last(call).error = String(event.error).slice(0, 1000); }
      if (event.type === 'ended') { call.ended = true; call.localClose?.(); }
      log({ event: event.type, ...(call.turns.length ? last(call) : { callId: call.id, variant: call.settings.variant, settings: call.settings }), clientAt: at, source: event.source });
      return reply(res, 200, { ok: true, turn: call.turns.at(-1) });
    }
    if (route === 'api/state') return reply(res, 200, { call: active ? { id: active.id, settings: active.settings, turns: active.turns, ended: active.ended } : null });
    return reply(res, 404, { error: 'Not found' });
  } catch (error) { console.error(String(error)); if (!res.headersSent) reply(res, 500, { error: String(error) }); else res.end(); }
});
await eleven.speechEngine.attach(cache.engineId, server, '/ws', {
  onInit(conversationId, session) { if (active && !active.ended) { active.conversationId = conversationId; log({ event: 'engine_connected', callId: active.id, conversationId }); } else session.close(); },
  onTranscript(transcript, signal, session) {
    const call = [...calls.values()].find(c => c.conversationId === session.conversationId);
    if (!call || call.ended) return;
    let row = call.turns.at(-1);
    if (!row || row.responseStartedAt || row.interrupted) row = turn(call);
    row.responseStartedAt = Date.now(); row.transcriptAt = row.responseStartedAt;
    const current = row;
    let responseFinished = false;
    const cpuStarted = process.cpuUsage();
    signal.addEventListener('abort', () => { if (responseFinished) return; current.interrupted = true; log({ event: 'engine_abort', ...current }); }, { once: true });
    async function* answer() {
      const model = models.find(m => m.id === call!.settings.responseModel)!;
      const messages: Message[] = transcript.map(m => ({ role: m.role === 'agent' ? 'assistant' : 'user', content: m.content }));
      let spoken = '';
      function sent(text: string, substantive = false) {
        if (!current.firstTextAt) { current.firstTextAt = Date.now(); current.firstTextSource = 'server_send_response'; }
        if (substantive) current.substantiveTextAt ??= Date.now();
        spoken += text; log({ event: 'text_sent', ...current, chunkChars: text.length }); return text;
      }
      try {
        if (call!.settings.buffer) yield sent('Okay... ');
        current.llmRequestAt = Date.now(); log({ event: 'llm_request', ...current });
        for await (const part of complete(model, call!.system, messages, signal, true, { cache: call!.settings.promptCache })) {
          if (part.usage) { current.usage = part.usage; log({ event: 'llm_usage', ...current }); }
          if (part.text || part.think || part.token) { current.firstTokenAt ??= Date.now(); log({ event: 'llm_token', ...current }); }
          if (signal.aborted) return;
          if (part.text) yield sent(part.text, true);
          if (part.think) {
            if (call!.settings.buffer) yield sent('Let me think through that... ');
            const result = think(call!, current, part.think, signal).then(text => ({ text }), error => ({ error }));
            while (!signal.aborted) {
              let timer: ReturnType<typeof setTimeout> | undefined;
              const next = await Promise.race([result, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 5000); })]);
              clearTimeout(timer);
              if (next === null) { yield sent(' '); continue; }
              if ('error' in next) throw next.error;
              if (!signal.aborted) yield sent(next.text, true);
              break;
            }
            break;
          }
        }
      } catch (error) { if (!signal.aborted) { current.error = String(error); yield sent('I could not finish that request. Please check the call log. '); } }
      finally { const cpu = process.cpuUsage(cpuStarted); current.cpuMs = (cpu.user + cpu.system) / 1000; responseFinished = true; current.responseFinished = true; current.responseFinishedAt = Date.now(); transcriptLog({ callId: call!.id, role: 'assistant', text: spoken, interrupted: signal.aborted }); log({ event: 'response_finished', ...current }); }
    }
    session.sendResponse(answer());
  },
  onError(error, session) { log({ event: 'engine_error', conversationId: session?.conversationId, error: String(error) }); },
});
attachLocal(server, accessPath, calls, voices, { turn, think, log, transcriptLog });
await build({ entryPoints: [join(root, 'client.ts')], bundle: true, format: 'esm', outfile: join(data, 'client.js'), platform: 'browser' });
server.listen(port, '127.0.0.1', () => console.log(`Ready ${publicUrl}/${accessPath}/`));

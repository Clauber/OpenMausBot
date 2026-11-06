import WebSocket from 'ws';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const data = join(import.meta.dirname, '.data');
const run = JSON.parse(readFileSync(join(data, 'run.json'), 'utf8'));
const base = process.env.POC_URL || run.url;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function post(path: string, body: object) {
  const res = await fetch(new URL(path, base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  const json = await res.json(); if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`); return json;
}
const config = await (await fetch(new URL('api/config', base))).json();
mkdirSync(join(data, 'audio'), { recursive: true, mode: 0o700 });
async function speech(text: string): Promise<Buffer> {
  const path = join(data, 'audio', createHash('sha256').update(config.voice + text).digest('hex') + '.pcm');
  if (existsSync(path)) return readFileSync(path);
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${config.voice}?output_format=pcm_16000`, { method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY!, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }), signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length < 3200) throw new Error('TTS returned too little PCM');
  writeFileSync(path, audio, { mode: 0o600 }); return audio;
}
const scenarios = [
  { name: 'hello', lines: ['Hello St. Paul. How are you today?', 'Nice. Tell me in one sentence what you do.'] },
  { name: 'memory', lines: ['Use your memory and think tool. What do you remember about my marketing team and how I like to work?'] },
  { name: 'tool', lines: ['Please use the think tool now. Ask your bot to use a read-only local file tool to list the files in its copied workspace, then tell me two names. Do not contact any external service.'] },
  { name: 'interrupt', lines: ['Explain your approach to planning a marketing campaign in ten detailed sentences.'] },
  { name: 'three-minute', lines: ['Hi St. Paul, let us talk about planning a small marketing experiment.', 'What makes a useful first experiment?', 'How would you keep the scope small?', 'What would you measure?', 'Explain that in plain language.', 'What might go wrong?', 'How can I make the review easier?', 'What is one next step?', 'Thanks. Summarize our conversation in one sentence.'] },
];
const responseModels = (process.env.POC_MODELS?.split(',') || ['claude-haiku-5-5', '9router:glm/glm-5.3-flash']).filter((id: string) => config.models.includes(id));
if (responseModels.length !== 2) throw new Error('Choose two reachable response models with POC_MODELS');
const matrix = [
  ...responseModels.flatMap((responseModel: string) => [false, true].map(buffer => ({ variant: 'engine', buffer, responseModel }))),
  { variant: 'agent', buffer: false, responseModel: responseModels[0] },
];
const summaryPath = join(data, 'logs/scripted.jsonl');
async function runCall(setting: typeof matrix[number], scenario: typeof scenarios[number]) {
  const settings = { ...setting, botId: config.bots[0].id, thinkingModel: 'bot', elevenAgentLlm: config.hostedModels[0] };
  let call;
  for (let attempt = 0; attempt < 6; attempt++) {
    try { call = await post('api/call', { ...settings, transport: 'websocket' }); break; }
    catch (error) {
      if (!/429|concurrent/i.test(String(error)) || attempt === 5) throw error;
      console.log('ElevenLabs concurrency limit. Retrying after 15 seconds.');
      await sleep(15000);
    }
  }
  const begun = Date.now();
  const event = (type: string, extra: object = {}) => post('api/event', { callId: call.callId, at: Date.now(), type, ...extra });
  const ws = new WebSocket(call.signedUrl);
  let lastReplyAt = 0, playbackUntil = 0, lastAudio = 0, audioBytes = 0, transcripts = 0, replies = 0, interruptions = 0, closed = false;
  let audioSeen = false, textSeen = false, sending = false, finishing = false, failure = '';
  const pending = new Set<Promise<unknown>>();
  function record(type: string, extra: object = {}) {
    const promise = event(type, extra).catch(error => { failure ||= String(error); });
    pending.add(promise); void promise.finally(() => pending.delete(promise));
  }
  let resolveAudio: (() => void) | undefined;
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'ping') ws.send(JSON.stringify({ type: 'pong', event_id: message.ping_event.event_id }));
    if (message.type === 'conversation_initiation_metadata') record('connected', { conversationId: message.conversation_initiation_metadata_event.conversation_id });
    if (message.type === 'user_transcript') { transcripts++; record('user_transcript', { text: message.user_transcription_event.user_transcript, source: 'scripted_server_transcript_arrival' }); }
    if (message.type === 'agent_response') { replies++; lastReplyAt = Date.now(); record('agent_transcript', { text: message.agent_response_event.agent_response }); if (!textSeen) { textSeen = true; record('first_text', { source: 'websocket_agent_text_arrival' }); } }
    if (message.type === 'agent_chat_response_part' && message.text_response_part?.text && !textSeen) { textSeen = true; record('first_text', { source: 'websocket_text_delta_arrival' }); }
    if (message.type === 'audio') {
      const bytes = Buffer.from(message.audio_event.audio_base_64, 'base64');
      audioBytes += bytes.length; lastAudio = Date.now(); playbackUntil = Math.max(lastAudio, playbackUntil) + bytes.length / 32;
      if (!audioSeen) { audioSeen = true; record('first_audio', { source: 'websocket_audio_arrival_proxy' }); resolveAudio?.(); }
    }
    if (message.type === 'interruption') { interruptions++; audioSeen = false; textSeen = false; playbackUntil = Date.now(); record('interrupted'); }
    if (message.type === 'error' || message.type === 'client_error') { failure = JSON.stringify(message).slice(0, 1500); record('error', { error: failure }); }
  });
  ws.on('error', error => { failure = String(error); });
  ws.on('close', (code, reason) => { closed = true; if (!finishing && code !== 1000) failure ||= `WebSocket closed ${code}: ${reason.toString()}`; });
  let silence: ReturnType<typeof setInterval> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('WS open timed out')), 30000); ws.once('open', () => { clearTimeout(timer); resolve(); }); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'conversation_initiation_client_data', conversation_config_override: call.overrides, dynamic_variables: call.dynamicVariables }));
    silence = setInterval(() => { if (!sending && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ user_audio_chunk: Buffer.alloc(3200).toString('base64') })); }, 100);
    await sleep(1000);
    async function speak(text: string) {
      const pcm = await speech(text);
      await event('user_begin');
      sending = true; audioSeen = false; textSeen = false;
      const started = Date.now();
      for (let at = 0; at < pcm.length; at += 3200) {
        if (closed) throw new Error('Conversation closed while sending speech');
        ws.send(JSON.stringify({ user_audio_chunk: pcm.subarray(at, at + 3200).toString('base64') }));
        await sleep(Math.max(0, started + (at + 3200) / 32 - Date.now()));
      }
      sending = false;
      await event('user_eos', { source: 'scripted_pcm_end' });
      console.log(`${setting.variant}/${setting.responseModel}/buffer=${setting.buffer} ${scenario.name}: sent ${Math.round(pcm.length / 32)} ms PCM`);
    }
    async function waitReply(timeout = 125000) {
      const at = Date.now();
      while (Date.now() - at < timeout) {
        if (failure) throw new Error(failure);
        if (closed) throw new Error('Conversation closed before response');
        if (audioSeen && Date.now() - lastAudio > 2500 && Date.now() > playbackUntil + 500) {
          await Promise.allSettled(pending);
          const state = await fetch(new URL('api/state', base)).then(r => r.json());
          const row = state.call.turns.at(-1);
          if (row?.error) throw new Error(row.error);
          const finishedAt = setting.variant === 'engine' ? row?.responseFinishedAt : row?.thinkCalled ? row.thinkFinishedAt : row?.eosAt;
          if (finishedAt && lastReplyAt >= finishedAt && Date.now() - lastReplyAt > 500) return;
        }
        await sleep(200);
      }
      throw new Error('No completed audio reply within timeout');
    }
    if (scenario.name === 'interrupt') {
      const first = new Promise<void>(resolve => { resolveAudio = resolve; });
      await speak(scenario.lines[0]);
      await Promise.race([first, sleep(45000).then(() => { throw new Error('No audio to interrupt'); })]);
      const deadline = Date.now() + 45000;
      while (audioBytes < 64000 || playbackUntil < Date.now() + 1000) {
        if (Date.now() > deadline || closed || failure) throw new Error('No substantial reply to interrupt');
        await sleep(100);
      }
      await sleep(500);
      await speak('Stop. Please give me only the short answer.');
      await waitReply();
      if (!interruptions) throw new Error('No real interruption event observed');
    } else {
      for (let i = 0; i < scenario.lines.length; i++) {
        if (scenario.name === 'three-minute') await sleep(Math.max(0, begun + 20000 * i - Date.now()));
        await speak(scenario.lines[i]); await waitReply();
      }
      if (scenario.name === 'three-minute') await sleep(Math.max(0, begun + 180000 - Date.now()));
    }
    if (!transcripts || !audioBytes || !replies) throw new Error('Missing real transcript, agent reply, or audio');
    const state = await fetch(new URL('api/state', base)).then(r => r.json());
    if (state.call.turns.some((row: { error?: string; interrupted: boolean }) => row.error && !row.interrupted)) throw new Error('Server turn failed');
    if (['memory', 'tool'].includes(scenario.name) && !state.call.turns.some((row: { thinkCalled: boolean; thinkMs?: number; interrupted: boolean; error?: string }) => row.thinkCalled && row.thinkMs !== undefined && !row.interrupted && !row.error)) throw new Error('Required think call did not complete');
  } catch (error) { failure = String(error); await event('error', { error: failure }); }
  finally {
    if (silence) clearInterval(silence);
    finishing = true; ws.close(1000); await Promise.allSettled(pending); await event('ended');
    const summary = { callId: call.callId, scenario: scenario.name, settings, startedAt: begun, elapsedMs: Date.now() - begun, audioBytes, transcripts, replies, interruptions, ok: !failure, error: failure || undefined };
    appendFileSync(summaryPath, JSON.stringify(summary) + '\n'); console.log(JSON.stringify(summary));
  }
}
const smoke = process.argv.includes('--smoke');
const selected = smoke ? scenarios.slice(0, 1) : scenarios.filter(s => !process.env.POC_SCENARIO || s.name === process.env.POC_SCENARIO);
for (const scenario of [...selected].sort((a, b) => Number(b.name === 'memory') - Number(a.name === 'memory'))) for (const setting of smoke ? [matrix[0], matrix.at(-1)!] : matrix) await runCall(setting, scenario);

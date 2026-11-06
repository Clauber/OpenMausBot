import { startLocal } from './local-client.ts';
import { Conversation } from '@elevenlabs/client';
const element = (id: string) => document.getElementById(id)!;
const select = (id: string) => element(id) as HTMLSelectElement;
let conversation: { endSession: () => Promise<unknown> } | undefined;
let callId = '', vadSpeaking = false;
function log(text: string) { const box = element('log'); box.textContent += `${new Date().toLocaleTimeString()} ${text}\n`; box.scrollTop = box.scrollHeight; }
async function post(path: string, body: object) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await res.json(); if (!res.ok) throw new Error(value.error || `HTTP ${res.status}`); return value;
}
async function event(type: string, extra: object = {}) {
  if (!callId) return;
  try {
    const result = await post('api/event', { callId, type, at: Date.now(), ...extra });
    const row = result.turn;
    if (type === 'first_audio' && row?.eosAt) log(`First audio ${row.firstAudioAt - row.eosAt} ms. ${row.firstAudioSource}.`);
  } catch (error) { log(String(error)); }
}
const config = await (await fetch('api/config')).json();
for (const bot of config.bots) select('bot').add(new Option(bot.name, bot.id));
for (const model of config.models) { select('response').add(new Option(model, model)); select('thinking').add(new Option(model, model)); }
for (const model of config.hostedModels) select('hosted').add(new Option(model, model));
if (config.realtimeAvailable) select('variant').add(new Option('ElevenLabs Realtime Mini, configured ElevenLabs voice', 'agent-realtime'));
element('voice').textContent = 'Local uses GX10 Haiku with recall on each turn. Its timing ends at server PCM receipt. Other variants use ElevenLabs turn and playback events.';
const creditMessage = config.credits.allowed ? `ElevenLabs: ${config.credits.balance} credits remaining. New requests require at least ${config.credits.floor}.` : `ElevenLabs disabled. Balance ${config.credits.balance ?? 'unavailable'}, minimum ${config.credits.floor}. Use AllTalk.`;
element('credits').textContent = creditMessage;
for (const voice of config.voices) select('voice-select').add(new Option(voice.name, voice.id));
select('voice-select').value = config.bots[0].voice;
for (const error of config.voiceErrors) log(error);
select('bot').addEventListener('change', () => { select('voice-select').value = config.bots.find((b: { id: string }) => b.id === select('bot').value)?.voice || config.voices[0]?.id; });
element('state').textContent = 'Ready';
for (const probe of config.probes) log(`${probe.id}: ${probe.ok ? 'available' : probe.error}`);
function busy(value: boolean) {
  (element('call') as HTMLButtonElement).disabled = value;
  (element('hangup') as HTMLButtonElement).disabled = !value;
  for (const id of ['bot', 'variant', 'voice-select', 'buffer', 'response', 'thinking', 'hosted', 'cache', 'context', 'topic', 'eagerness', 'timeout', 'speculative']) (element(id) as HTMLInputElement).disabled = value;
}
select('variant').addEventListener('change', () => {
  if (select('variant').value !== 'engine') (element('cache') as HTMLInputElement).checked = false;
  if (select('variant').value === 'agent-realtime') select('context').value = 'full';
});
element('call').addEventListener('click', async () => {
  busy(true);
  try {
    const permission = await navigator.mediaDevices.getUserMedia({ audio: true });
    permission.getTracks().forEach(track => track.stop());
    const call = await post('api/call', { botId: select('bot').value, variant: select('variant').value, voice: select('voice-select').value, buffer: (element('buffer') as HTMLInputElement).checked, responseModel: select('response').value, thinkingModel: select('thinking').value, elevenAgentLlm: select('hosted').value, promptCache: (element('cache') as HTMLInputElement).checked, contextMode: select('context').value, callTopic: (element('topic') as HTMLInputElement).value, turnEagerness: select('eagerness').value, turnTimeout: Number((element('timeout') as HTMLInputElement).value), speculativeTurn: (element('speculative') as HTMLInputElement).checked });
    callId = call.callId;
    if (call.local) {
      conversation = await startLocal(callId, message => {
        if (message.type === 'ready') { element('state').textContent = 'Listening'; log('Local connected'); }
        if (message.type === 'speech_start') element('state').textContent = 'Listening';
        if (message.type === 'transcript') { log(`You: ${message.text}`); element('state').textContent = 'Thinking'; }
        if (message.type === 'text') log(`Bot: ${message.text}`);
        if (message.type === 'audio') element('state').textContent = 'Speaking';
        if (message.type === 'done') {
          const row = message.timing;
          log(`EOS to audio ${row.firstAudioAt - row.eosAt} ms. STT ${row.transcriptAt - row.sttRequestAt} ms, reply token ${row.firstTokenAt - row.llmRequestAt} ms, TTS ${row.firstAudioAt - row.ttsRequestAt} ms. Recall ${row.recallPassages} passages.`);
        }
        if (message.type === 'error') { log(String(message.error)); element('state').textContent = 'Local error. See log.'; }
      }, () => { element('state').textContent = 'Disconnected'; busy(false); void event('ended'); });
      return;
    }
    conversation = await Conversation.startSession({
      conversationToken: call.conversationToken, connectionType: 'webrtc', overrides: call.overrides, dynamicVariables: call.dynamicVariables,
      onConnect: ({ conversationId }) => { element('state').textContent = 'Connected'; log(`Connected ${conversationId}`); void event('connected', { conversationId }); },
      onDisconnect: () => { element('state').textContent = 'Disconnected'; busy(false); void event('ended'); },
      onModeChange: ({ mode }) => { element('state').textContent = mode; if (mode === 'speaking') void event('first_audio', { source: 'client_mode_speaking_proxy' }); },
      onVadScore: ({ vadScore }) => {
        if (vadScore > 0.6) vadSpeaking = true;
        if (vadSpeaking && vadScore < 0.2) { vadSpeaking = false; void event('user_eos', { source: 'client_vad_falling_edge' }); }
      },
      onMessage: message => { log(`${message.source}: ${message.message}`); void event(message.source === 'user' ? 'user_transcript' : 'agent_transcript', { text: message.message }); if (message.source !== 'user') void event('first_text', { source: 'client_agent_transcript_arrival' }); },
      onInterruption: () => { log('Interrupted'); void event('interrupted'); },
      onError: message => { log(`Error ${message}`); void event('error', { error: message }); },
    });
  } catch (error) { log(String(error)); element('state').textContent = 'Call failed'; await event('error', { error: String(error) }); await event('ended'); busy(false); }
});
element('hangup').addEventListener('click', async () => { await conversation?.endSession(); await event('ended'); conversation = undefined; busy(false); });

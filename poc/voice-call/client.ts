import { Conversation } from '@elevenlabs/client';
const element = (id: string) => document.getElementById(id)!;
const select = (id: string) => element(id) as HTMLSelectElement;
let conversation: Awaited<ReturnType<typeof Conversation.startSession>> | undefined;
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
element('voice').textContent = `ElevenLabs voice ${config.voice}. Timings use VAD and speaking-mode events, which approximate playback.`;
element('state').textContent = 'Ready';
for (const probe of config.probes) log(`${probe.id}: ${probe.ok ? 'available' : probe.error}`);
function busy(value: boolean) {
  (element('call') as HTMLButtonElement).disabled = value;
  (element('hangup') as HTMLButtonElement).disabled = !value;
  for (const id of ['bot', 'variant', 'buffer', 'response', 'thinking', 'hosted']) (element(id) as HTMLInputElement).disabled = value;
}
element('call').addEventListener('click', async () => {
  busy(true);
  try {
    const permission = await navigator.mediaDevices.getUserMedia({ audio: true });
    permission.getTracks().forEach(track => track.stop());
    const call = await post('api/call', { botId: select('bot').value, variant: select('variant').value, buffer: (element('buffer') as HTMLInputElement).checked, responseModel: select('response').value, thinkingModel: select('thinking').value, elevenAgentLlm: select('hosted').value });
    callId = call.callId;
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

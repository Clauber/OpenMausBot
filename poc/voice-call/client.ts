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
element('voice').textContent = 'Local uses GX10 transcription, the selected reply model, and recall. Jev gates background work. ElevenLabs Turbo streams audio over one connection. Timings end at server PCM receipt.';
const creditMessage = config.credits.allowed ? `ElevenLabs: ${config.credits.balance} credits remaining. New requests require at least ${config.credits.floor}.` : `ElevenLabs disabled. Balance ${config.credits.balance ?? 'unavailable'}, minimum ${config.credits.floor}. Use AllTalk.`;
element('credits').textContent = creditMessage;
for (const voice of config.voices) select('voice-select').add(new Option(voice.name, voice.id));
select('voice-select').value = config.bots[0].voice;
for (const error of config.voiceErrors) log(error);
select('bot').addEventListener('change', () => { select('voice-select').value = config.bots.find((b: { id: string }) => b.id === select('bot').value)?.voice || config.voices[0]?.id; });
element('state').textContent = 'Ready';
for (const probe of config.probes) log(`${probe.id}: ${probe.ok ? 'available' : probe.error}`);
let libraryPage = 0, libraryQuery = '';
async function searchVoices(more = false) {
  const status = element('voice-status'), results = element('voice-results');
  if (!more) { libraryPage = 0; libraryQuery = (element('voice-query') as HTMLInputElement).value.trim(); results.replaceChildren(); }
  if (!libraryQuery) return;
  status.textContent = 'Searching...';
  (element('voice-search') as HTMLButtonElement).disabled = true;
  try {
    const res = await fetch(`api/voices/search?q=${encodeURIComponent(libraryQuery)}&page=${libraryPage}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    for (const voice of body.voices) {
      const row = document.createElement('li'), label = document.createElement('p'), use = document.createElement('button');
      label.textContent = `${voice.name}. ${voice.description}`; row.append(label);
      if (voice.preview) { const preview = document.createElement('a'); preview.href = voice.preview; preview.target = '_blank'; preview.rel = 'noreferrer noopener'; preview.textContent = 'Preview voice'; row.append(preview); }
      use.textContent = 'Add and use'; use.type = 'button'; use.disabled = !!callId;
      use.onclick = async () => {
        use.disabled = true;
        try {
          const added = await post('api/voices/add', { ownerId: voice.ownerId, voiceId: voice.voiceId, name: voice.name });
          if (!Array.from(select('voice-select').options).some(option => option.value === added.voice.id)) select('voice-select').add(new Option(added.voice.name, added.voice.id));
          select('voice-select').value = added.voice.id;
          status.textContent = `Selected ${voice.name}. This voice is now in your ElevenLabs account.`;
          log(status.textContent);
        } catch (error) { status.textContent = String(error); log(String(error)); }
        finally { use.disabled = !!callId; }
      };
      row.append(use); results.append(row);
    }
    element('voice-more').hidden = !body.hasMore;
    status.textContent = results.children.length ? `${results.children.length} matches. Preview a voice, then add it to use it.` : 'No matches. Try a different name or description.';
  } catch (error) { status.textContent = String(error); }
  finally { (element('voice-search') as HTMLButtonElement).disabled = false; }
}
element('voice-library').addEventListener('submit', event => { event.preventDefault(); void searchVoices(); });
element('voice-more').addEventListener('click', () => { libraryPage++; void searchVoices(true); });

function busy(value: boolean) {
  for (const button of element('voice-results').querySelectorAll('button')) button.disabled = value;
  (element('call') as HTMLButtonElement).disabled = value;
  (element('hangup') as HTMLButtonElement).disabled = !value;
  for (const id of ['bot', 'variant', 'voice-select', 'voice-query', 'voice-search', 'voice-more', 'buffer', 'response', 'thinking', 'hosted', 'cache', 'context', 'topic', 'eagerness', 'timeout', 'speculative']) (element(id) as HTMLInputElement).disabled = value;
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
        if (message.type === 'notice') log(message.text);
        if (message.type === 'audio') element('state').textContent = 'Speaking';
        if (message.type === 'done') {
          const row = message.timing;
          log(`EOS to audio ${row.firstAudioAt - row.eosAt} ms. First token to audio ${row.firstTokenAt ? row.firstAudioAt - row.firstTokenAt : 'n/a'} ms. TTS ${row.firstAudioAt - row.ttsRequestAt} ms. Recall ${row.recallPassages ?? 0} passages.`);
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

import type { Turn } from './server.ts';
type LocalMessage =
  | { type: 'ready' | 'speech_start' | 'empty' }
  | { type: 'notice'; text: string }
  | { type: 'text' | 'transcript'; text: string; turnId: number }
  | { type: 'audio'; pcm: string; sampleRate: number; turnId: number }
  | { type: 'error'; error: string; turnId?: number }
  | { type: 'done'; turnId: number; timing: Required<Pick<Turn, 'eosAt' | 'firstAudioAt' | 'transcriptAt' | 'sttRequestAt' | 'firstTokenAt' | 'llmRequestAt' | 'ttsRequestAt' | 'recallPassages'>> };

export async function startLocal(callId: string, onMessage: (message: LocalMessage) => void, onClose: () => void) {
  const audio = new AudioContext();
  await audio.resume();
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  const url = new URL('local', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('callId', callId);
  const ws = new WebSocket(url);
  const input = audio.createMediaStreamSource(mic), processor = audio.createScriptProcessor(2048, 1, 1), mute = audio.createGain();
  mute.gain.value = 0; input.connect(processor); processor.connect(mute); mute.connect(audio.destination);
  const sources = new Set<AudioBufferSourceNode>();
  let nextAt = 0, stopped = false;
  const stopPlayback = () => { for (const source of sources) source.stop(); sources.clear(); nextAt = 0; };
  function close() {
    if (stopped) return;
    stopped = true; stopPlayback(); processor.disconnect(); input.disconnect(); mute.disconnect();
    mic.getTracks().forEach(track => track.stop()); void audio.close(); ws.close(); onClose();
  }
  processor.onaudioprocess = event => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const samples = event.inputBuffer.getChannelData(0), ratio = audio.sampleRate / 16000;
    const pcm = new Int16Array(Math.floor(samples.length / ratio));
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.max(-1, Math.min(1, samples[Math.floor(i * ratio)])) * 32767;
    ws.send(pcm.buffer);
  };
  ws.onmessage = event => {
    const message: LocalMessage = JSON.parse(event.data);
    if (message.type === 'speech_start') stopPlayback();
    if (message.type === 'audio') {
      const bytes = Uint8Array.from(atob(message.pcm), c => c.charCodeAt(0)), view = new DataView(bytes.buffer);
      const buffer = audio.createBuffer(1, bytes.length / 2, message.sampleRate), channel = buffer.getChannelData(0);
      for (let i = 0; i < channel.length; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
      const source = audio.createBufferSource(); source.buffer = buffer; source.connect(audio.destination);
      sources.add(source); source.onended = () => sources.delete(source);
      nextAt = Math.max(nextAt, audio.currentTime + 0.03); source.start(nextAt); nextAt += buffer.duration;
    }
    onMessage(message);
  };
  ws.onerror = () => { onMessage({ type: 'error', error: 'Local connection failed' }); close(); };
  ws.onclose = close;
  return { endSession: async () => close() };
}

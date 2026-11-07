import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Turn } from './server.ts';

const data = join(import.meta.dirname, '.data');
function jsonl<T>(file: string): T[] {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
type Sample = { callId: string; scenario: string; runTag: string; settings: { label: string }; ok: boolean; loads: { load: number[] }[]; elapsedMs: number; callerCpu: { user: number; system: number } };
type Event = Partial<Turn> & { event: string; loggedAt: number; clientAt?: number; callId: string; turnId?: number };
type Alignment = { callId: string; sequence: number; firstRealAudioAt?: number; firstWordAudioAt?: number; excludedWords: number; loss?: number; error?: string };
type Wire = { callId: string; sequence: number; type: string; at: number; message?: { agent_response_event?: { agent_response: string } } };
type Word = { text: string; start: number; end: number; loss: number };
const samples = jsonl<Sample>(join(data, 'logs/round2-scripted.jsonl')).filter(s => s.runTag === (process.env.POC_RUN_TAG || 'matrix'));
const calls = new Map(samples.map(s => [s.callId, s]));
const rows = new Map<string, Turn>();
const events = jsonl<Event>(join(data, 'logs/calls.jsonl')).filter(e => calls.has(e.callId));
for (const event of events) {
  if (!calls.has(event.callId) || !event.turnId) continue;
  const key = `${event.callId}/${event.turnId}`;
  const row = { ...rows.get(key), ...event } as Turn;
  if (event.event === 'think_called') row.thinkStartedAt ??= event.loggedAt;
  rows.set(key, row);
}
const byCall = new Map<string, Turn[]>();
for (const callId of calls.keys()) {
  const callEvents = events.filter(e => e.callId === callId);
  const begins = callEvents.filter(e => e.event === 'user_begin');
  const endings = callEvents.filter(e => e.event === 'user_eos' && e.eosSource === 'scripted_pcm_end');
  const generations = [...rows.values()].filter(r => r.callId === callId);
  const turns: Turn[] = [];
  for (let index = 0; index < endings.length; index++) {
    const start = begins[index]?.clientAt || begins[index]?.loggedAt || 0;
    const next = begins[index + 1]?.clientAt || Infinity;
    const candidates = generations.filter(r => (r.transcriptAt || r.eosAt) >= start && (r.transcriptAt || r.eosAt) < next).sort((a, b) => a.turnId - b.turnId);
    const final = candidates.findLast(r => !r.interrupted && !r.error && r.firstAudioAt) || candidates.at(-1);
    if (final) turns.push({ ...final, eosAt: endings[index].clientAt || endings[index].eosAt!, eosSource: 'scripted_pcm_end' });
  }
  byCall.set(callId, turns);
}
const wire = jsonl<Wire>(join(data, 'logs/round2-wire.jsonl'));
const metricsDir = join(data, 'conversations');
mkdirSync(metricsDir, { recursive: true, mode: 0o700 });
if (process.argv.includes('--fetch-metrics')) for (const callId of calls.keys()) {
  const metadata = wire.find(w => w.callId === callId && w.type === 'conversation_initiation_metadata')?.message as { conversation_initiation_metadata_event?: { conversation_id: string } } | undefined;
  const id = metadata?.conversation_initiation_metadata_event?.conversation_id;
  if (!id) continue;
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(id)}`, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY! }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) { console.log(JSON.stringify({ callId, metricsStatus: response.status })); continue; }
  writeFileSync(join(metricsDir, `${callId}.json`), JSON.stringify(await response.json()), { mode: 0o600 });
}
type HostedTurn = { role: string; producing_llm?: string; conversation_turn_metrics?: { metrics?: Record<string, { elapsed_time: number }> }; llm_usage?: { model_usage: Record<string, { input: { tokens: number }; input_cache_read: { tokens: number }; input_cache_write: { tokens: number } }> } };
const hosted = new Map<string, HostedTurn[]>();
for (const callId of calls.keys()) {
  const file = join(metricsDir, `${callId}.json`);
  if (!existsSync(file)) continue;
  const transcript: HostedTurn[] = JSON.parse(readFileSync(file, 'utf8')).transcript || [];
  let sequence = 0;
  for (const item of transcript) {
    if (item.role === 'user') sequence++;
    if (item.role !== 'agent' || !sequence) continue;
    const key = `${callId}/${sequence}`;
    if (!hosted.has(key)) hosted.set(key, []);
    hosted.get(key)!.push(item);
  }
}
const alignPath = join(data, 'logs/round2-aligned.jsonl');
const aligned = new Map(jsonl<Alignment>(alignPath).map(a => [`${a.callId}/${a.sequence}`, a]));

function wav(pcm: Buffer) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

if (process.argv.includes('--align')) {
  for (const [callId, turns] of byCall) for (let index = 0; index < turns.length; index++) {
    const sequence = index + 1, key = `${callId}/${sequence}`, stem = join(data, 'audio', `${callId}-${sequence}`);
    if (aligned.get(key)?.firstRealAudioAt || !existsSync(stem + '.pcm')) continue;
    const row = turns[index];
    const text = wire.filter(w => w.callId === callId && w.sequence === sequence && w.type === 'agent_response')
      .map(w => w.message?.agent_response_event?.agent_response || '').join(' ').trim();
    const result: Alignment = { callId, sequence, excludedWords: 0 };
    try {
      if (!text) throw new Error('No final transcript to align');
      const form = new FormData(); form.append('file', new Blob([wav(readFileSync(stem + '.pcm'))], { type: 'audio/wav' }), 'response.wav'); form.append('text', text);
      const response = await fetch('https://api.elevenlabs.io/v1/forced-alignment', { method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY! }, body: form, signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(`Alignment HTTP ${response.status}`);
      const body: { words: Word[]; loss: number } = await response.json();
      writeFileSync(stem + '-alignment.json', JSON.stringify({ text, ...body }), { mode: 0o600 });
      const reviewPath = join(data, 'round2-answer-offsets.json');
      const reviewed: Record<string, number> = existsSync(reviewPath) ? JSON.parse(readFileSync(reviewPath, 'utf8')) : {};
      const words = body.words.filter(w => w.text.trim());
      const prefix = text.match(/^\s*(?:(?:okay|ok|sure|alright)[,.!]?\s*)?(?:(?:let me (?:think|check|look)[^.!?]*[.!?]|i(?:'ll| will) (?:check|look|think|pull|read|search)[^.!?]*[.!?])\s*)?/i)?.[0] || '';
      result.excludedWords = reviewed[key] ?? prefix.trim().split(/\s+/).filter(Boolean).length;
      const chosen = words[result.excludedWords];
      if (!chosen) throw new Error('Transcript has no real answer after excluded preamble');
      const timing: { chunks: { at: number; end: number }[] } = JSON.parse(readFileSync(stem + '.json', 'utf8'));
      const arrival = (word: Word) => timing.chunks.find(c => c.end > word.start * 32000)?.at;
      result.firstWordAudioAt = arrival(words[0]); result.firstRealAudioAt = arrival(chosen); result.loss = body.loss;
      if (row.thinkCalled && row.thinkFinishedAt && result.firstRealAudioAt! < row.thinkFinishedAt) throw new Error('Aligned answer precedes think completion; manual preamble review required');
    } catch (error) { result.firstRealAudioAt = undefined; result.error = String(error); }
    aligned.set(key, result);
    writeFileSync(alignPath, [...aligned.values()].map(a => JSON.stringify(a)).join('\n') + '\n', { mode: 0o600 });
    console.log(JSON.stringify(result));
  }
}

function stats(values: number[]) {
  const a = values.filter(Number.isFinite).sort((a, b) => a - b);
  return a.length ? { n: a.length, median: a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2, p90: a[Math.ceil(a.length * .9) - 1], min: a[0], max: a.at(-1)! } : null;
}
const out: object[] = [];
for (const label of new Set(samples.map(s => s.settings.label))) for (const scenario of ['hello', 'memory', 'interrupt', 'tool']) {
  const group = samples.filter(s => s.settings.label === label && s.scenario === scenario);
  if (!group.length) continue;
  const all = group.flatMap(s => (byCall.get(s.callId) || []).map((r, index) => ({ ...r, alignment: aligned.get(`${r.callId}/${index + 1}`), hosted: hosted.get(`${r.callId}/${index + 1}`) || [], callOk: s.ok })));
  const valid = all.filter(r => r.callOk && !r.error && !r.interrupted);
  const generations = [...rows.values()].filter(r => group.some(s => s.callId === r.callId));
  const interval = (end: keyof Turn, begin: keyof Turn) => stats(valid.map(r => typeof r[end] === 'number' && typeof r[begin] === 'number' ? Number(r[end]) - Number(r[begin]) : NaN).filter(n => begin === 'eosAt' && end === 'transcriptAt' || n >= 0));
  const loads = group.flatMap(s => s.loads.map(l => l.load[0]));
  const answer = stats(valid.filter(r => r.alignment?.firstRealAudioAt && r.alignment.firstRealAudioAt >= r.eosAt).map(r => r.alignment!.firstRealAudioAt! - r.eosAt));
  const vendorMetric = (name: string) => stats(valid.flatMap(r => r.hosted.flatMap(h => { const metric = h.conversation_turn_metrics?.metrics?.[name]; return metric ? [metric.elapsed_time * 1000] : []; })));
  const producingModels = [...new Set(valid.flatMap(r => r.hosted.map(h => h.producing_llm).filter(Boolean)))];
  const hostedInput = valid.flatMap(r => r.hosted.slice(0, 1).flatMap(h => h.llm_usage ? [Object.values(h.llm_usage.model_usage).reduce((sum, u) => sum + u.input.tokens + u.input_cache_read.tokens + u.input_cache_write.tokens, 0)] : []));
  const phases = { eosToTranscript: interval('transcriptAt', 'eosAt'), transcriptToRequest: interval('llmRequestAt', 'transcriptAt'), requestToToken: interval('firstTokenAt', 'llmRequestAt'), tokenToText: interval('firstTextAt', 'firstTokenAt'), textToAudio: interval('firstAudioAt', 'firstTextAt'), thinkToAudio: interval('firstAudioAt', 'thinkFinishedAt'), thinkToRealAudio: stats(valid.filter(r => r.thinkFinishedAt && r.alignment?.firstRealAudioAt && r.alignment.firstRealAudioAt >= r.thinkFinishedAt).map(r => r.alignment!.firstRealAudioAt! - r.thinkFinishedAt!)), thinkQueue: interval('botRequestAt', 'thinkStartedAt'), thinkAgent: interval('thinkFinishedAt', 'botRequestAt'), think: stats(valid.filter(r => r.thinkMs !== undefined).map(r => r.thinkMs!)) };
  out.push({ label, scenario, calls: group.length, passedCalls: group.filter(s => s.ok).length, turns: all.length, generations: generations.length, cancelledGenerations: generations.filter(r => r.interrupted).length, generationErrors: generations.filter(r => r.error && !r.interrupted).length, interrupted: all.filter(r => r.interrupted).length, errors: all.filter(r => r.error).length, firstAudio: interval('firstAudioAt', 'eosAt'), firstRealAudio: answer, phases, producingModels, vendorPhases: { llmTtfb: vendorMetric('convai_llm_service_ttfb'), ttsTtfb: vendorMetric('convai_tts_service_ttfb'), turnSilence: vendorMetric('convai_turn_silence_before_initiation'), asr: vendorMetric('convai_turn_asr_latency'), failedAttempts: vendorMetric('agents_llm_service_failed_attempts_latency'), audioSinceSilence: vendorMetric('convai_ttf_audio_since_silence') }, inputTokens: stats([...valid.filter(r => r.usage).map(r => r.usage!.inputTokens), ...(!valid.some(r => r.usage) ? hostedInput : [])]), cacheReadTokens: stats(valid.filter(r => r.usage).map(r => r.usage!.cacheReadTokens)), cacheCreationTokens: stats(valid.filter(r => r.usage).map(r => r.usage!.cacheCreationTokens)), hostLoad: stats(loads), callerCpuPercent: stats(group.map(s => (s.callerCpu.user + s.callerCpu.system) / (s.elapsedMs * 10))), serverCpuMs: stats(valid.filter(r => r.cpuMs !== undefined).map(r => r.cpuMs!)), preambleExcludedTurns: valid.filter(r => r.alignment?.excludedWords).length, missingAnswerMarks: valid.filter(r => !r.alignment?.firstRealAudioAt).length, negativeAnswerIntervals: valid.filter(r => r.alignment?.firstRealAudioAt && r.alignment.firstRealAudioAt < r.eosAt).length });
}
const output = JSON.stringify(out, null, 2);
writeFileSync(join(data, `round2-summary-${process.env.POC_RUN_TAG || 'matrix'}.json`), output, { mode: 0o600 });
if (!process.argv.includes('--align')) console.log(output);

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const path = process.argv[2] || join(import.meta.dirname, '.data/logs/calls.jsonl');
const rows = new Map<string, any>();
let errors = 0;
for (const line of readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)) {
  const row = JSON.parse(line);
  if (row.event === 'error' || row.event === 'engine_error') errors++;
  if (row.turnId) rows.set(`${row.callId}/${row.turnId}`, { ...rows.get(`${row.callId}/${row.turnId}`), ...row });
}
const groups = new Map<string, any[]>();
for (const row of rows.values()) {
  const s = row.settings;
  const key = `${row.variant} | ${s.buffer ? 'on' : 'off'} | ${row.variant === 'agent' ? s.elevenAgentLlm : s.responseModel} | ${s.thinkingModel} | ${row.eosSource} | ${row.firstAudioSource || 'none'}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(row);
}
function stats(values: number[]) {
  const a = values.filter(Number.isFinite).sort((a,b) => a-b);
  if (!a.length) return 'n/a';
  const median = a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
  return `${Math.round(median)} / ${Math.round(a[Math.ceil(a.length * .9) - 1])}`;
}
console.log('| Variant | Buffer | Response / hosted LLM | Thinking | EOS signal | Audio signal | Turns / audio | First audio median / p90 ms | First text median / p90 ms | Think completed / called | Think median / p90 ms | Interrupted | Failed |');
console.log('|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|');
for (const [key, group] of groups) {
  const valid = group.filter(r => !r.error && !r.interrupted);
  const audio = valid.filter(r => r.firstAudioAt >= r.eosAt);
  const text = valid.filter(r => r.firstTextAt >= r.eosAt);
  console.log(`| ${key} | ${group.length} / ${audio.length} | ${stats(audio.map(r => r.firstAudioAt - r.eosAt))} | ${stats(text.map(r => r.firstTextAt - r.eosAt))} | ${valid.filter(r => r.thinkCalled && r.thinkMs !== undefined).length} / ${group.filter(r => r.thinkCalled).length} | ${stats(valid.filter(r => r.thinkMs !== undefined).map(r => r.thinkMs))} | ${group.filter(r => r.interrupted).length} | ${group.filter(r => r.error).length} |`);
}
console.log(`\nEvent errors: ${errors}. Interrupted and failed turns are excluded from latency percentiles. Missing or negative intervals are excluded, never counted as zero. WebSocket audio arrival and browser speaking mode are proxies for audio playback. Hosted first text is client receipt because the hosted LLM does not expose server-send timestamps.`);

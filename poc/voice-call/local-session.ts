import type { Message } from './models.ts';
import type { Turn } from './server.ts';
import type { GateDecision, ListenerGate } from './listener.ts';
import { SpeechText, stripTags } from './speech-text.ts';

export type SpeechSink = { write(text: string): void; finish(): Promise<void> };
export type SessionHooks = {
  turn(at: number, source?: string): Turn;
  prepare(text: string): { system: string; recall: string; passages: number };
  reply(system: string, history: Message[], signal: AbortSignal): AsyncIterable<{ text?: string; think?: string; token?: boolean }>;
  gate: ListenerGate;
  think(request: string, signal: AbortSignal, row: Turn): Promise<string>;
  speaker(id: string, signal: AbortSignal, audio: (pcm: Buffer) => void): Promise<SpeechSink>;
  send(message: object): void;
  log(message: object): void;
  transcript(role: 'user' | 'assistant', text: string): void;
};
type Foreground = { controller: AbortController; row: Turn; user?: Message; eosAt: number; generated: string; saved?: Message; buffered: Buffer[] };
type Job = { request: string; row: Turn; conversation: Message[] };

export class LocalSession {
  readonly history: Message[] = [];
  readonly lifetime = new AbortController();
  playUntil = 0;
  private foreground?: Foreground;
  private captures = 0;
  private pendingJobs: Job[] = [];
  private running?: Job;
  private results: string[] = [];
  private resultTimer?: ReturnType<typeof setTimeout>;
  private hooks: SessionHooks;
  private eleven: boolean;

  constructor(hooks: SessionHooks, eleven: boolean) { this.hooks = hooks; this.eleven = eleven; }

  captureStart() { this.captures++; }

  captureEnd(text: string, startedAt: number, eosAt: number) {
    this.captures = Math.max(0, this.captures - 1);
    this.input(text, startedAt, eosAt);
    if (!this.captures && this.foreground) {
      const fg = this.foreground;
      for (const pcm of fg.buffered.splice(0)) this.audio(fg, pcm);
      if (fg.row.responseFinished) this.settle(fg);
    }
    this.deliverResults();
  }

  input(text: string, startedAt = Date.now(), eosAt = Date.now()) {
    if (this.lifetime.signal.aborted) return;
    text = text.trim();
    if (!/[\p{L}\p{N}]/u.test(stripTags(text))) { this.hooks.send({ type: 'empty' }); return; }
    const old = this.foreground;
    if (old?.user && !old.row.firstAudioAt && startedAt - old.eosAt <= 1500 && startedAt >= old.eosAt) {
      text = `${old.user.content} ${text}`;
      this.history.splice(this.history.indexOf(old.user), 1);
      this.notice('local_merged', `Merged speech into one turn: ${stripTags(text)}`, { turnId: old.row.turnId });
    }
    this.interrupt();
    const row = this.hooks.turn(eosAt, 'confirmed_transcript');
    row.transcriptAt = Date.now();
    const user: Message = { role: 'user', content: text };
    this.history.push(user);
    this.hooks.send({ type: 'transcript', turnId: row.turnId, text: stripTags(text).trim() });
    this.hooks.transcript('user', stripTags(text).trim());
    const fg: Foreground = { controller: new AbortController(), row, user, eosAt, generated: '', buffered: [] };
    this.foreground = fg;
    void this.respond(fg);
  }

  async greet() {
    const row = this.hooks.turn(Date.now(), 'greeting');
    const fg: Foreground = { controller: new AbortController(), row, eosAt: Date.now(), generated: '', buffered: [] };
    this.foreground = fg;
    await this.say(fg, 'Hello.');
  }

  private interrupt() {
    const fg = this.foreground;
    if (fg && !fg.controller.signal.aborted) {
      fg.row.interrupted = true;
      fg.controller.abort();
      this.saveSpeech(fg);
      this.hooks.log({ event: 'local_interrupted', ...fg.row });
    }
    this.playUntil = 0;
    this.hooks.send({ type: 'speech_start' });
  }

  private notice(event: string, text: string, fields: object = {}) {
    this.hooks.send({ type: 'notice', text });
    this.hooks.log({ event, ...fields });
  }

  private audio(fg: Foreground, pcm: Buffer) {
    if (fg.controller.signal.aborted || this.lifetime.signal.aborted) return;
    if (!fg.row.firstAudioAt && this.captures) { fg.buffered.push(pcm); return; }
    fg.row.firstAudioAt ??= Date.now(); fg.row.firstAudioSource = 'server_tts_pcm';
    this.playUntil = Math.max(this.playUntil, Date.now()) + pcm.length / 48;
    if (!fg.saved) { fg.saved = { role: 'assistant', content: '' }; this.history.push(fg.saved); }
    fg.saved.content = stripTags(fg.generated);
    this.hooks.send({ type: 'audio', turnId: fg.row.turnId, pcm: pcm.toString('base64'), sampleRate: 24000 });
  }

  private saveSpeech(fg: Foreground) {
    if (fg.saved?.content.trim()) this.hooks.transcript('assistant', fg.saved.content);
  }

  private async respond(fg: Foreground) {
    const signal = AbortSignal.any([fg.controller.signal, this.lifetime.signal, AbortSignal.timeout(115000)]);
    const row = fg.row;
    let task = '', gate: GateDecision | undefined;
    const snapshot = this.history.map(m => ({ ...m }));
    try {
      const prepared = this.hooks.prepare(fg.user!.content);
      row.recallAt = Date.now(); row.recallPassages = prepared.passages;
      const gated = this.hooks.gate.decide({ conversation: snapshot, recall: prepared.recall, pending: [...(this.running ? [this.running] : []), ...this.pendingJobs].map(j => j.request) }, signal).then(decision => {
        gate = decision;
        this.notice('listener_decision', `Jev: ${decision.choice}, top p=${decision.probability ?? 'unavailable'}, ${decision.latencyMs} ms${decision.reason ? `, ${decision.reason}` : ''}`, { turnId: row.turnId, ...decision });
        if (decision.choice === 'agent' && !signal.aborted) {
          this.enqueue({ request: task || fg.user!.content, conversation: snapshot, row });
        }
      }).catch(() => undefined);
      const sink = await this.hooks.speaker(String(row.turnId), signal, pcm => this.audio(fg, pcm));
      const text = new SpeechText(this.eleven);
      const write = (chunk: string, final = false) => {
        const cleaned = text.push(chunk, final);
        fg.generated += cleaned.speech;
        if (cleaned.speech) { row.ttsRequestAt ??= Date.now(); sink.write(cleaned.speech); }
        if (cleaned.display) { row.firstTextAt ??= Date.now(); this.hooks.send({ type: 'text', turnId: row.turnId, text: cleaned.display }); }
      };
      row.llmRequestAt = Date.now();
      const pending = [...(this.running ? [this.running] : []), ...this.pendingJobs].map(job => job.request);
      const system = prepared.system + (pending.length ? `\nBackground work pending, do not repeat it: ${pending.join('; ')}` : '');
      for await (const part of this.hooks.reply(system, snapshot, signal)) {
        signal.throwIfAborted();
        if (part.text || part.token || part.think) row.firstTokenAt ??= Date.now();
        if (part.text) write(part.text);
        if (part.think) task = part.think.slice(0, 6000);
      }
      if (!stripTags(fg.generated).trim()) write(task || gate?.choice === 'agent' ? 'Let me check on that.' : 'Could you say that again?');
      write('', true);
      await sink.finish();
      signal.throwIfAborted();
      void gated;
    } catch (error) {
      if (!fg.controller.signal.aborted && !this.lifetime.signal.aborted) { row.error = String(error); this.hooks.send({ type: 'error', turnId: row.turnId, error: row.error }); }
    } finally {
      row.responseFinished = true; row.responseFinishedAt = Date.now();
      this.hooks.log({ event: 'local_finished', ...row });
      this.settle(fg);
    }
  }

  private enqueue(job: Job) {
    this.pendingJobs.push(job);
    if (this.running) this.notice('background_queued', 'Full-agent task queued.', { turnId: job.row.turnId });
    void this.runJobs();
  }

  private async runJobs() {
    if (this.running || this.lifetime.signal.aborted) return;
    const job = this.pendingJobs.shift();
    if (!job) return;
    this.running = job;
    const at = Date.now();
    this.notice('background_started', 'Full agent started in the background.', { turnId: job.row.turnId });
    try {
      const conversation = job.conversation.map(m => `${m.role}: ${m.content}`).join('\n');
      const result = await this.hooks.think(`Task: ${job.request}\n\nFull phone conversation:\n${conversation}`, this.lifetime.signal, job.row);
      if (!this.lifetime.signal.aborted) {
        this.results.push(`Okay, I checked. ${stripTags(result)}`);
        this.notice('background_finished', `Full agent finished in ${Date.now() - at} ms.`, { turnId: job.row.turnId, ms: Date.now() - at });
      }
    } catch (error) {
      if (!this.lifetime.signal.aborted) { this.notice('background_failed', `Full agent failed after ${Date.now() - at} ms: ${String(error)}`, { turnId: job.row.turnId }); this.results.push('I could not finish that check. You can ask me to try again.'); }
    } finally {
      this.running = undefined;
      this.deliverResults();
      void this.runJobs();
    }
  }

  private deliverResults() {
    clearTimeout(this.resultTimer);
    if (!this.results.length || this.foreground || this.captures || this.lifetime.signal.aborted) return;
    const wait = this.playUntil - Date.now();
    if (wait > 0) { this.resultTimer = setTimeout(() => this.deliverResults(), wait + 30); return; }
    const result = this.results.shift()!;
    const row = this.hooks.turn(Date.now(), 'background_result');
    const fg: Foreground = { controller: new AbortController(), row, eosAt: Date.now(), generated: '', buffered: [] };
    this.foreground = fg;
    void this.say(fg, result);
  }

  private async say(fg: Foreground, text: string) {
    const signal = AbortSignal.any([fg.controller.signal, this.lifetime.signal, AbortSignal.timeout(30000)]);
    try {
      const sink = await this.hooks.speaker(String(fg.row.turnId), signal, pcm => this.audio(fg, pcm));
      fg.generated = text;
      fg.row.ttsRequestAt = Date.now();
      this.hooks.send({ type: 'text', turnId: fg.row.turnId, text: stripTags(text) });
      sink.write(text);
      await sink.finish();
    } catch (error) { if (!signal.aborted) this.hooks.send({ type: 'error', error: String(error) }); }
    finally { fg.row.responseFinished = true; this.settle(fg); }
  }

  private settle(fg: Foreground) {
    if (fg.buffered.length && !fg.controller.signal.aborted) return;
    if (!fg.controller.signal.aborted && !this.lifetime.signal.aborted) {
      if (!fg.row.firstAudioAt && !fg.row.error) {
        fg.row.error = 'TTS returned no audio';
        this.hooks.send({ type: 'error', turnId: fg.row.turnId, error: fg.row.error });
      }
      this.saveSpeech(fg);
      this.hooks.send({ type: 'done', turnId: fg.row.turnId, timing: fg.row });
    }
    if (this.foreground === fg) this.foreground = undefined;
    this.deliverResults();
  }

  close() {
    this.lifetime.abort(); this.foreground?.controller.abort();
    clearTimeout(this.resultTimer); this.pendingJobs = []; this.results = [];
  }
}

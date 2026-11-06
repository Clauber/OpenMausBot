import { readFileSync } from 'node:fs';
export type Model = { id: string; modelId?: string; provider: 'openai' | 'anthropic' | 'gemini' | 'groq' | 'compat'; key: string; baseUrl?: string; route?: string; reasoningEffort?: string };
const credentials = new Map<string, string>();
export const discovery: object[] = [];
export type Message = { role: 'user' | 'assistant'; content: string };
export type SystemPrompt = string | { stable: string[]; thread: string };
export type Usage = { inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; outputTokens: number };
export type CompletionOptions = { cache?: boolean; maxTokens?: number };
export const candidates: Model[] = [
  { id: 'gpt-4.1-mini', provider: 'openai', key: 'OPENAI_API_KEY' },
  { id: 'gpt-5.4-mini', provider: 'openai', key: 'OPENAI_API_KEY' },
  { id: 'claude-haiku-5-5', provider: 'anthropic', key: 'ANTHROPIC_API_KEY' },
  { id: 'gemini-2.5-flash', provider: 'gemini', key: 'GEMINI_KEY' },
  { id: 'openai/gpt-oss-120b', provider: 'groq', key: 'GROQ_MEETING_KEY' },
  { id: 'cliproxy:gpt-6-luna', modelId: 'gpt-6-luna', provider: 'compat', key: 'CLI_PROXY_API_KEY', baseUrl: 'http://100.64.0.9:8317/v1', reasoningEffort: 'low' },
];
const functionSchema = { name: 'think', description: 'Ask the bot agent to reason, recall memory, or use its tools. Always use this for tool requests and explicit requests to think.', parameters: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'], additionalProperties: false } };
export async function* complete(model: Model, system: SystemPrompt, messages: Message[], signal: AbortSignal, tool = false, options: CompletionOptions = {}): AsyncGenerator<{ text?: string; think?: string; usage?: Usage; token?: boolean }> {
  const key = process.env[model.key] || credentials.get(model.key);
  if (!key) throw new Error(`Missing ${model.key}`);
  const systemText = typeof system === 'string' ? system : [...system.stable, system.thread].join('\n');
  const systemBlocks = typeof system === 'string' ? system : [...system.stable.map(text => ({ type: 'text', text, ...(options.cache ? { cache_control: { type: 'ephemeral' } } : {}) })), { type: 'text', text: system.thread }];
  let url: string;
  let body: Record<string, unknown>;
  let headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (model.provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/messages';
    headers = { ...headers, 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    body = { model: model.id, system: systemBlocks, messages, stream: true, max_tokens: options.maxTokens || 600, thinking: { type: 'disabled' }, ...(tool ? { tools: [{ name: functionSchema.name, description: functionSchema.description, input_schema: functionSchema.parameters }] } : {}) };
  } else if (model.provider === 'gemini') {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:streamGenerateContent?alt=sse`;
    headers['x-goog-api-key'] = key;
    body = { systemInstruction: { parts: [{ text: systemText }] }, contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), generationConfig: { maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } }, ...(tool ? { tools: [{ functionDeclarations: [functionSchema] }] } : {}) };
  } else {
    url = `${model.baseUrl || (model.provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1')}/chat/completions`;
    headers.Authorization = `Bearer ${key}`;
    body = { model: model.modelId || model.id, messages: [{ role: 'system', content: systemText }, ...messages], stream: true, stream_options: { include_usage: true }, max_tokens: options.maxTokens || 600, ...(model.reasoningEffort ? { reasoning_effort: model.reasoningEffort } : {}), ...(tool ? { tools: [{ type: 'function', function: functionSchema }] } : {}) };
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error(`${model.id} HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  if (!res.body) throw new Error('Empty model stream');
  let pending = '', args = '', name = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    pending += decoder.decode(chunk, { stream: true });
    let at: number;
    while ((at = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, at).trim(); pending = pending.slice(at + 1);
      if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') continue;
      const data = JSON.parse(line.slice(5));
      if (data.error) throw new Error(`${model.id}: ${JSON.stringify(data.error).slice(0, 300)}`);
      const usage = data.message?.usage || data.usage || data.usageMetadata;
      if (usage && (usage.input_tokens !== undefined || usage.prompt_tokens !== undefined || usage.promptTokenCount !== undefined)) yield { usage: { inputTokens: (usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount ?? 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0), cacheReadTokens: usage.cache_read_input_tokens || usage.prompt_tokens_details?.cached_tokens || 0, cacheCreationTokens: usage.cache_creation_input_tokens || 0, outputTokens: usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount ?? 0 } };
      if (model.provider === 'anthropic') {
        if (data.delta?.type === 'text_delta') yield { text: data.delta.text };
        if (data.content_block?.type === 'tool_use') { name = data.content_block.name; yield { token: true }; }
        if (data.delta?.partial_json) args += data.delta.partial_json;
      } else if (model.provider === 'gemini') {
        for (const part of data.candidates?.[0]?.content?.parts || []) {
          if (part.text && !part.thought) yield { text: part.text };
          if (part.functionCall?.name === 'think') yield { think: part.functionCall.args.request };
        }
      } else {
        const delta = data.choices?.[0]?.delta;
        if (delta?.content) yield { text: delta.content };
        for (const call of delta?.tool_calls || []) { name += call.function?.name || ''; args += call.function?.arguments || ''; }
      }
    }
  }
  if (name === 'think') yield { think: JSON.parse(args).request };
}
async function discover() {
  const cfg = JSON.parse(readFileSync('/home/clauber/.openmausbot/config.json', 'utf8'));
  const routes = [
    { name: '9router', url: cfg.openaiCompat?.url || 'https://9router.gsdut.dev/v1', key: process.env['9R_KEY'] || cfg.openaiCompat?.key },
    ...Object.entries({ cerebras: 'https://api.cerebras.ai/v1', groq: 'https://api.groq.com/openai/v1', mistral: 'https://api.mistral.ai/v1', deepseek: 'https://api.deepseek.com', xai: 'https://api.x.ai/v1', openrouter: 'https://openrouter.ai/api/v1' }).map(([name, url]) => ({ name, url, key: cfg[name]?.key || (name === 'deepseek' ? process.env.DEEPSEEK_API_KEY : undefined) })),
  ];
  for (const route of routes) {
    if (!route.key) { discovery.push({ route: route.name, status: 'no configured key' }); continue; }
    credentials.set(`route:${route.name}`, route.key);
    try {
      const response = await fetch(`${route.url.replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${route.key}` }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) { discovery.push({ route: route.name, status: response.status }); continue; }
      const body = await response.json();
      const ids: string[] = (body.data || body.models || []).map((m: { id: string }) => m.id);
      const preferred = ['ci/gpt-5.4-mini', 'ci/gpt-4.1-nano', 'ci/gemini-3.8-flash', 'ci/gemini-3.1-flash-lite', 'gx10/claude-haiku-5-5', 'glm/glm-5.3-flash', 'ds/deepseek-v4.1-flash', 'ci/claude-haiku-5.5'];
      const fast = route.name === '9router' ? preferred.filter(id => ids.includes(id)) : ids.filter(id => /mini|nano|flash|fast|haiku|8b|20b|deepseek-chat/i.test(id)).slice(0, 2);
      discovery.push({ route: route.name, status: response.status, modelIds: ids, selected: fast });
      for (const id of fast) candidates.push({ id: `${route.name}:${id}`, modelId: id, provider: 'compat', key: `route:${route.name}`, baseUrl: route.url.replace(/\/$/, ''), route: route.name });
    } catch (error) { discovery.push({ route: route.name, error: String(error) }); }
  }
}

export async function probeModels() {
  await discover();
  const results = await Promise.all(candidates.map(async model => {
    const at = Date.now();
    try {
      let answer = '';
      for await (const part of complete(model, 'Reply with one word.', [{ role: 'user', content: 'Say ready.' }], AbortSignal.timeout(25000))) answer += part.text || '';
      if (!answer.trim()) throw new Error('No text returned');
      return { ...model, ok: true, ms: Date.now() - at };
    } catch (error) { return { ...model, ok: false, ms: Date.now() - at, error: String(error) }; }
  }));
  return results;
}

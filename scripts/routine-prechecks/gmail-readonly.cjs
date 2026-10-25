'use strict';

// Run inside the existing Gmail gateway container. Credentials stay there.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const accounts = new Set(['main', 'cklauber', 'clauber93']);
const methods = new Set(['gmail.users.messages.list', 'gmail.users.messages.get']);
const account = process.argv[1];
const timeout = setTimeout(() => process.exit(1), 100_000);
const line = value => String(value || '').split(/\r?\n/).find(x => x.trim())?.trim() || '';

async function call(method, params) {
  if (!accounts.has(account) || !methods.has(method)) throw new Error('Denied');
  const { stdout } = await execute('gog', ['--readonly', '--gmail-no-send',
    '--json', '--no-input', 'api', 'call', 'gmail', 'v1', method,
    '--scope', 'https://www.googleapis.com/auth/gmail.readonly', '--params', JSON.stringify(params)],
  { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  const value = JSON.parse(stdout);
  if (!value || typeof value !== 'object' || value.error) throw new Error('Invalid response');
  return value;
}

async function scan(input) {
  if (!Array.isArray(input.seen) || !input.seen.every(x => typeof x === 'string')) throw new Error('Invalid state');
  const seen = new Set(input.seen);
  const ids = new Set();
  const cursors = new Set();
  let pageToken;
  do {
    const response = await call('gmail.users.messages.list', { userId: 'me', labelIds: ['UNREAD'],
      maxResults: 500, ...(pageToken ? { pageToken } : {}) });
    if (response.messages !== undefined && !Array.isArray(response.messages)) throw new Error('Invalid messages');
    for (const message of response.messages || []) {
      if (!message || !/^[a-fA-F0-9]{1,128}$/.test(message.id || '')) throw new Error('Invalid id');
      ids.add(message.id);
    }
    if (ids.size > 20_000) throw new Error('Scan limit');
    pageToken = response.nextPageToken;
    if (pageToken !== undefined && (typeof pageToken !== 'string' || !pageToken || cursors.has(pageToken))) throw new Error('Invalid cursor');
    if (pageToken) cursors.add(pageToken);
    if (cursors.size > 50) throw new Error('Page limit');
  } while (pageToken);
  const fresh = [...ids].filter(id => !seen.has(id));
  const items = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, fresh.length) }, async () => {
    while (next < fresh.length) {
      const id = fresh[next++];
      const response = await call('gmail.users.messages.get', { userId: 'me', id, format: 'metadata',
        metadataHeaders: ['From', 'Subject'], fields: 'id,snippet,payload/headers' });
      if (response.id !== id || typeof response.snippet !== 'string' || !Array.isArray(response.payload?.headers)) throw new Error('Invalid message');
      const header = name => response.payload.headers.find(h => String(h.name).toLowerCase() === name)?.value;
      items.push({ id, from: line(header('from')).slice(0, 150), subject: line(header('subject')).slice(0, 180),
        snippet: line(response.snippet).slice(0, 240) });
    }
  }));
  return { items: items.sort((a, b) => a.id.localeCompare(b.id)), ids: [...ids] };
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', value => { input += value; if (input.length > 4 * 1024 * 1024) process.exit(1); });
process.stdin.on('end', async () => {
  try { process.stdout.write(JSON.stringify(await scan(JSON.parse(input))) + '\n'); }
  catch { process.stderr.write('Gmail read-only scan failed.\n'); process.exitCode = 1; }
  finally { clearTimeout(timeout); }
});

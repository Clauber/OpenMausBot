import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdirSync, openSync, readFileSync, writeFileSync, existsSync, renameSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname), data = join(root, '.data');
mkdirSync(join(data, 'logs'), { recursive: true, mode: 0o700 });
if (existsSync(join(data, 'run.json'))) {
  const old = JSON.parse(readFileSync(join(data, 'run.json'), 'utf8'));
  try { process.kill(old.supervisorPid, 0); throw new Error(`Already running as PID ${old.supervisorPid}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
async function freePort() {
  const server = createServer();
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No free port');
  await new Promise<void>(r => server.close(() => r()));
  return address.port;
}
const devPort = await freePort(), webhookPort = await freePort(), pocPort = await freePort();
const children: ChildProcess[] = [];
let stopping = false;
function boot(name: string, command: string, args: string[], env: NodeJS.ProcessEnv) {
  const path = join(data, 'logs', `${name}.log`);
  if (existsSync(path)) renameSync(path, `${path}.${Date.now()}`);
  const fd = openSync(path, 'w', 0o600);
  const child = spawn(command, args, { cwd: resolve(root, '../..'), env, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  children.push(child);
  child.on('error', error => { console.error(`${name}: ${error.message}`); stop(); });
  child.on('exit', code => { if (!stopping) { console.error(`${name} exited ${code}`); stop(); } });
  return child;
}
function stop() { if (stopping) return; stopping = true; for (const child of children) child.kill('SIGTERM'); setTimeout(() => process.exit(0), 3000).unref(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
const dev = boot('omb', process.execPath, ['--experimental-strip-types', 'server/openmausbot.ts', 'serve', '--no-pair', '--port', String(devPort), '--data-dir', join(data, 'omb')], {
  PATH: process.env.PATH, HOME: join(data, 'home'), USER: process.env.USER, LANG: 'C.UTF-8',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OMB_DATA_DIR: join(data, 'omb'), OMB_PORT: String(devPort), OMB_WEBHOOK_PORT: String(webhookPort), OMB_LOOPBACK_TRUST: 'owner',
  CLAUDE_CONFIG_DIR: join(data, 'home/.claude'),
});
for (let i = 0; i < 120; i++) {
  try { const res = await fetch(`http://127.0.0.1:${devPort}/api/health`); if (res.ok) break; } catch {}
  if (i === 119 || stopping) throw new Error('Dev OMB failed readiness. See .data/logs/omb.log');
  await new Promise(r => setTimeout(r, 500));
}
const tunnel = boot('tunnel', '/home/clauber/.local/bin/cloudflared', ['tunnel', '--url', `http://127.0.0.1:${pocPort}`, '--no-autoupdate', '--protocol', 'http2'], { PATH: process.env.PATH, HOME: join(data, 'home') });
let url = '';
for (let i = 0; i < 120; i++) {
  const log = readFileSync(join(data, 'logs/tunnel.log'), 'utf8');
  url = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)?.at(-1) || '';
  if (url) break;
  if (stopping) throw new Error('Tunnel stopped');
  await new Promise(r => setTimeout(r, 500));
}
if (!url) { stop(); throw new Error('No quick tunnel URL'); }
const accessPath = randomBytes(24).toString('hex');
const poc = boot('poc', process.execPath, ['--experimental-strip-types', join(root, 'server.ts')], { ...process.env, POC_PORT: String(pocPort), POC_ACCESS_PATH: accessPath, POC_PUBLIC_URL: url, POC_OMB_PORT: String(devPort) });
const info = { url: `${url}/${accessPath}/`, devPort, webhookPort, pocPort, supervisorPid: process.pid, devLauncherPid: dev.pid, tunnelPid: tunnel.pid, pocPid: poc.pid, snapshot: join(data, 'omb') };
writeFileSync(join(data, 'run.json'), JSON.stringify(info, null, 2), { mode: 0o600 });
console.log(JSON.stringify(info, null, 2));
console.log(`Stop all owned children: kill -TERM ${process.pid}`);

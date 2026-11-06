import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname);
const live = '/home/clauber/.openmausbot';
const dest = join(root, '.data/omb');
if (existsSync(join(dest, 'snapshot.json'))) throw new Error('Snapshot exists. Use a new checkout to take another snapshot.');
mkdirSync(dest, { recursive: true, mode: 0o700 });
const all = JSON.parse(readFileSync(join(live, 'bots.json'), 'utf8'));
const names = (process.env.POC_BOTS || 'St. Paul').split(',');
const bots = all.filter((b: { name: string; id: string }) => names.includes(b.name) || names.includes(b.id));
if (!bots.length) throw new Error('No selected bots found');
const config = JSON.parse(readFileSync(join(live, 'config.json'), 'utf8'));
const changes: string[] = [];
for (const file of ['config.json', 'bots.json']) cpSync(join(live, file), join(dest, file));
function copyTree(source: string, target: string) {
  if (!existsSync(source)) return;
  if (lstatSync(source).isSymbolicLink()) { changes.push(`Skipped symlink ${source.replace(live, '')}`); return; }
  if (lstatSync(source).isDirectory()) {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(source)) copyTree(join(source, entry), join(target, entry));
  } else cpSync(source, target);
}
for (const b of bots) copyTree(join(live, 'bots', b.id), join(dest, 'bots', b.id));
copyTree(join(live, 'memory-journal'), join(dest, 'memory-journal'));
const sqlite = process.env.SQLITE3 || join(root, '.data/tools/usr/bin/sqlite3');
execFileSync(sqlite, [join(live, 'messages.db'), `.backup '${join(dest, 'messages.db').replaceAll("'", "''")}'`]);
const features = Object.fromEntries(['skillAuthoring', 'skillReview', 'browser', 'sharedComputers', 'claudeUserMcp', 'claudeUserSkills', 'llmThreadTitles', 'smartSetupChoices', 'autoRecall', 'skillsLibrary', 'roomMemoryCapture', 'parallelRoomJobs', 'chiefEscalations', 'agentsToolBridge', 'savedSteps'].map(k => [k, false]));
const safeConfig = {
  profile: config.profile,
  onboarding: config.onboarding,
  instances: { claude: { driver: 'claudeAgent', config: { cli: config.instances?.claude?.config?.cli || 'claude' } } },
  mcpServers: {}, features,
  automaticRecovery: { enabled: false },
  tts: { provider: 'elevenlabs', voice: bots[0].voice || config.tts?.voice || '' },
};
changes.push(`Config allowlist retained profile, onboarding, voice; replaced instances with local Claude only; removed ${Object.keys(config).filter(k => !['profile', 'onboarding', 'tts', 'instances', 'features', 'mcpServers', 'automaticRecovery'].includes(k)).join(', ')}`);
writeFileSync(join(dest, 'config.json'), JSON.stringify(safeConfig, null, 2));
const safeKeys = ['id', 'threadId', 'name', 'title', 'description', 'soul', 'soulHash', 'color', 'createdAt', 'modelSelection', 'voiceProvider', 'voice'];
for (let i = 0; i < bots.length; i++) {
  const b = bots[i];
  const workspace = join(dest, 'workspaces', b.id);
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  copyTree(join(live, 'workspaces', b.id, 'MEMORY.md'), join(workspace, 'MEMORY.md'));
  copyTree(join(live, 'workspaces', b.id, 'memory'), join(workspace, 'memory'));
  const soul = join(dest, 'bots', b.id, 'SOUL.md');
  if (existsSync(soul)) cpSync(soul, join(workspace, 'SOUL.md'));
  changes.push(`Bot ${b.name}: removed ${Object.keys(b).filter(k => !safeKeys.includes(k)).join(', ')}; fresh cwd; ask permissions; no browser, connectors, MCP, teammates or resume cursors`);
  bots[i] = { ...Object.fromEntries(safeKeys.filter(k => k in b).map(k => [k, b[k]])), cwd: workspace, approvalMode: 'ask', autoApprove: false, browser: false, notifications: false, mcpServers: {}, connectorTools: [], composio: [], tasks: [] };
}
writeFileSync(join(dest, 'bots.json'), JSON.stringify(bots, null, 2));
execFileSync(sqlite, [join(dest, 'messages.db'), 'DELETE FROM chat_followups; DELETE FROM command_receipts; DELETE FROM running_turns;']);
changes.push('Copied messages using sqlite3 .backup; cleared copied chat_followups, command_receipts and running_turns. No runtime.db, sessions, routines, channels, webhooks, providers, approvals, companion, push, backups, fleet, OAuth or environment files copied.');
writeFileSync(join(dest, 'snapshot.json'), JSON.stringify({ source: live, at: new Date().toISOString(), botIds: bots.map((b: { id: string }) => b.id), changes }, null, 2));
mkdirSync(join(root, '.data/home'), { recursive: true, mode: 0o700 });
console.log(`Snapshot ${dest}, ${bots.map((b: { name: string }) => b.name).join(', ')}`);

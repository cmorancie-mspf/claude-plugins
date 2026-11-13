// Tests for core/: sync.mjs (the shared code is copied into each plugin that carries it, and a copy
// that differs from core/ is caught) and the bridge, with a stand-in for OpenCode that spends nothing.
// Run: node core/tests/test_core.mjs
// Works on a temporary copy of a small fake repository; touches nothing in the real one.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SYNC = path.join(CORE, 'sync.mjs');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'core-test-'));

let pass = 0; const failed = [];
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log('PASS ' + name); } else { failed.push(name); console.log('FAIL ' + name + (detail ? '   [' + String(detail).slice(0, 300) + ']' : '')); } };
const run = (...a) => {
  try { return { code: 0, out: execFileSync(process.execPath, [SYNC, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
};

// A fake repository: core/ with two parts, two plugins.
const root = path.join(T, 'repo');
const w = (rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
w('core/bridge/oc.mjs', 'export const a = 1;\n');
w('core/bridge/configs/rules.json', '{"permission":{"bash":"deny"}}\n');
w('core/lib/store.mjs', 'export const s = 1;\n');
w('core/consumers.json', JSON.stringify({ 'plug-a': ['bridge'], 'plug-b': ['bridge', 'lib'] }));
fs.mkdirSync(path.join(root, 'plug-a'), { recursive: true });
fs.mkdirSync(path.join(root, 'plug-b'), { recursive: true });

let r = run('--check', '--root', root);
ok('check fails when a consumer has no copy yet', r.code === 1 && /plug-a\/bridge\/oc\.mjs: missing/.test(r.out), r.out);

r = run('--root', root);
ok('sync copies each part into each consumer', r.code === 0
  && fs.readFileSync(path.join(root, 'plug-a/bridge/oc.mjs'), 'utf8') === 'export const a = 1;\n'
  && fs.existsSync(path.join(root, 'plug-b/lib/store.mjs')) && fs.existsSync(path.join(root, 'plug-b/bridge/configs/rules.json')), r.out);
ok('a part a consumer does not carry is not copied', !fs.existsSync(path.join(root, 'plug-a/lib')));

r = run('--check', '--root', root);
ok('check passes when every copy matches', r.code === 0, r.out);

fs.writeFileSync(path.join(root, 'plug-b/bridge/oc.mjs'), 'export const a = 2;\n');
r = run('--check', '--root', root);
ok('check fails on a copy edited in place, and names it', r.code === 1 && /plug-b\/bridge\/oc\.mjs: differs from core/.test(r.out), r.out);

fs.writeFileSync(path.join(root, 'plug-b/bridge/oc.mjs'), 'export const a = 1;\r\n');
r = run('--check', '--root', root);
ok('a copy that differs only in line endings (a Windows checkout) matches', r.code === 0, r.out);

fs.writeFileSync(path.join(root, 'plug-a/bridge/extra.mjs'), 'x');
r = run('--check', '--root', root);
ok('check fails on a file in a copy that core does not have', r.code === 1 && /plug-a\/bridge\/extra\.mjs: not in core/.test(r.out), r.out);

r = run('--root', root);
ok('sync removes a file core does not have', r.code === 0 && !fs.existsSync(path.join(root, 'plug-a/bridge/extra.mjs')), r.out);

w('core/consumers.json', JSON.stringify({ 'plug-a': ['nope'] }));
r = run('--check', '--root', root);
ok('a consumer naming a part core does not have is refused', r.code === 2 && /no part "nope"/.test(r.out), r.out);
w('core/consumers.json', JSON.stringify({ '../outside': ['bridge'] }));
r = run('--root', root);
ok('a consumer outside the repository is refused', r.code === 2 && /not a plugin folder/.test(r.out), r.out);

// The real repository: every copy matches core today.
r = run('--check');
ok('the real repository: every copy matches core', r.code === 0, r.out);

// ---------- the bridge (core/bridge): provider cap, end classification, env scrub, record format 2
// A stand-in for OpenCode: the bridge runs `<opencode> run ...`, and with node as the binary that
// runs the file named `run` in the run folder. STUB_MODE says how it ends. Nothing is spent.
const OC = path.join(CORE, 'bridge', 'oc.mjs');
const MCP = path.join(CORE, 'bridge', 'mcp.mjs');
const BH = path.join(T, 'bridge-home');
const BENV = { ...process.env, OC_BRIDGE_HOME: BH, OC_BRIDGE_OPENCODE: process.execPath, CLOUD_TOKEN: 'secret-1', cloud_lower: 'secret-2', KEEP_ME: 'kept' };
delete BENV.OPENCODE_CONFIG; delete BENV.OPENCODE_CONFIG_CONTENT;
const oc = (args, env = {}) => {
  try { return { code: 0, out: execFileSync(process.execPath, [OC, ...args], { encoding: 'utf8', env: { ...BENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
};
const BJ = (x) => { try { return JSON.parse(x.out.slice(x.out.indexOf('{'))); } catch { return null; } };
const work = path.join(T, 'work'); fs.mkdirSync(work);
fs.writeFileSync(path.join(work, 'run'), `
const fs = require('fs');
const mode = process.env.STUB_MODE || 'ok';
fs.writeFileSync('env-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json', JSON.stringify(Object.keys(process.env)));
if (mode === 'hold') { setTimeout(() => {}, 60000); }
else if (mode === '429') { console.log('working'); console.error('Error: 429 Too Many Requests: rate limit reached for this model'); process.exit(1); }
else if (mode === 'auth') { console.error('Error: 401 Unauthorized: invalid api key'); process.exit(1); }
else if (mode === 'quota') { console.error('Error: insufficient credits on this account'); process.exit(1); }
else if (mode === 'other') { console.error('TypeError: x is not a function'); process.exit(1); }
else if (mode === 'early429') { console.log('test output: expected 429 from the mock'); for (let i = 0; i < 40; i++) console.log('line ' + i); console.error('segfault'); process.exit(1); }
else if (mode === 'ok429') { console.log('a test asserted a 429 response'); process.exit(0); }
else console.log('stub ran');
`);
const rulesFile = path.join(T, 'rules.json');
fs.writeFileSync(rulesFile, JSON.stringify({ permission: { bash: { '*': 'allow', '*git push*': 'deny' } } }));
const waitRun = (id) => oc(['wait', id, '--stall-min', '2']);
const startRun = (id, extra = [], env = {}) => oc(['start', id, '--dir', work, '--prompt', 'hi', '--config', rulesFile, ...extra], env);

for (const [mode, kind] of [['429', 'rate_limited'], ['auth', 'auth'], ['quota', 'quota'], ['other', 'other']]) {
  startRun('end-' + mode, ['--model', 'prov/m-1'], { STUB_MODE: mode }); waitRun('end-' + mode);
  const st = BJ(oc(['status', 'end-' + mode]));
  ok(`B1 a run that ends with ${mode} output and exit 1 is classified ${kind}`, st?.status === 'failed' && st?.end_kind === kind, JSON.stringify(st));
}
startRun('end-early', ['--model', 'prov/m-1'], { STUB_MODE: 'early429' }); waitRun('end-early');
ok('B1 a 429 far above the end of the log does not make a rate-limit death', BJ(oc(['status', 'end-early']))?.end_kind === 'other');
startRun('end-ok', ['--model', 'prov/m-1'], { STUB_MODE: 'ok429' }); waitRun('end-ok');
ok('B1 a run that exits 0 is "ok" whatever its output says', BJ(oc(['status', 'end-ok']))?.end_kind === 'ok');
const rec = JSON.parse(fs.readFileSync(path.join(BH, 'runs', 'end-ok', 'state.json'), 'utf8'));
ok('B2 the run record is format 2', rec.format === 2, JSON.stringify(rec).slice(0, 200));

// scrub_env: names and PREFIX_* patterns, any case, kept with the run for later turns
for (const f of fs.readdirSync(work).filter((x) => x.startsWith('env-'))) fs.rmSync(path.join(work, f));
let x = startRun('scrub', ['--scrub-env', 'CLOUD_*,OTHER']); waitRun('scrub');
const envSeen = () => fs.readdirSync(work).filter((f) => f.startsWith('env-')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(work, f), 'utf8')));
let keys = envSeen().pop() || [];
ok('B3 scrub_env drops matching variables whatever their case, and keeps the rest', x.code === 0 && !keys.some((k) => /^cloud_/i.test(k)) && keys.includes('KEEP_ME'), x.out + JSON.stringify(keys.filter((k) => /cloud|keep/i.test(k))));
oc(['answer', 'scrub', '--prompt', 'again']); waitRun('scrub');
keys = envSeen().pop() || [];
ok('B3 a later turn of the run keeps the same scrub', !keys.some((k) => /^cloud_/i.test(k)) && keys.length > 0);
x = startRun('scrub-bad', ['--scrub-env', 'A B']);
ok('B3 a scrub entry that is not a variable name or PREFIX_* is refused', x.code === 2 && /scrub/.test(x.out), x.out);

// provider cap, counted against the shared run store
x = startRun('cap-a', ['--model', 'prov/m-1', '--max-concurrent', '1'], { STUB_MODE: 'hold' });
ok('B4 a run under the provider cap starts', x.code === 0, x.out);
x = startRun('cap-b', ['--model', 'prov/m-2', '--max-concurrent', '1']);
ok('B4 a second live run on the same provider over its cap is refused', x.code === 2 && /provider "prov"/.test(x.out), x.out);
ok('B4 nothing is recorded for the refused run', !fs.existsSync(path.join(BH, 'runs', 'cap-b')));
x = startRun('cap-c', ['--model', 'other/m-1', '--max-concurrent', '1']); waitRun('cap-c');
ok('B4 another provider is counted separately', x.code === 0, x.out);
x = startRun('cap-d', ['--max-concurrent', '1']);
ok('B4 a cap without a model is refused (the provider is unknown)', x.code === 2 && /model/.test(x.out), x.out);
oc(['stop', 'cap-a']);
x = startRun('cap-e', ['--model', 'prov/m-1', '--max-concurrent', '1']); waitRun('cap-e');
ok('B4 after the live run stops, the provider has room again', x.code === 0, x.out);
// two starts at once with a cap of 1: the lock lets exactly one through
const { spawn } = await import('node:child_process');
const race = (id) => new Promise((res) => { const p = spawn(process.execPath, [OC, 'start', id, '--dir', work, '--prompt', 'hi', '--config', rulesFile, '--model', 'race/m-1', '--max-concurrent', '1'], { env: { ...BENV, STUB_MODE: 'hold' }, stdio: 'ignore' }); p.on('exit', (code) => res(code)); });
const codes = await Promise.all([race('race-1'), race('race-2'), race('race-3')]);
ok('B4 three starts at once against a cap of 1: exactly one starts', codes.filter((c) => c === 0).length === 1, JSON.stringify(codes));
for (const id of ['race-1', 'race-2', 'race-3']) if (fs.existsSync(path.join(BH, 'runs', id))) oc(['stop', id]);

// the MCP layer: cap and scrub reach start; a plugin can offer only some tools
const mcpCall = (req, env = {}) => { const out = execFileSync(process.execPath, [MCP], { input: JSON.stringify(req) + '\n', encoding: 'utf8', env: { ...BENV, ...env } }); return JSON.parse(out.trim().split('\n').pop()); };
let m = mcpCall({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
const startTool = m.result.tools.find((t) => t.name === 'opencode_start');
ok('B5 opencode_start takes max_concurrent and scrub_env', !!startTool?.inputSchema.properties.max_concurrent && !!startTool?.inputSchema.properties.scrub_env);
m = mcpCall({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { OC_BRIDGE_TOOLS: 'status,stop,list' });
ok('B5 OC_BRIDGE_TOOLS limits the tools offered (no start, no answer)', m.result.tools.map((t) => t.name).sort().join(',') === 'opencode_list,opencode_status,opencode_stop', JSON.stringify(m.result.tools.map((t) => t.name)));
m = mcpCall({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'opencode_start', arguments: { id: 'hidden', dir: work, prompt: 'hi', config: rulesFile } } }, { OC_BRIDGE_TOOLS: 'status,stop,list' });
ok('B5 a hidden tool cannot be called', !!m.error || m.result?.isError === true, JSON.stringify(m));
m = mcpCall({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'opencode_start', arguments: { id: 'mcp-cap', dir: work, prompt: 'hi', config: rulesFile, model: 'prov/m-1', max_concurrent: 1, scrub_env: ['CLOUD_*'] } } });
const mrec = (() => { try { return JSON.parse(fs.readFileSync(path.join(BH, 'runs', 'mcp-cap', 'state.json'), 'utf8')); } catch { return null; } })();
ok('B5 through MCP the cap and the scrub list are kept with the run', !m.result?.isError && mrec?.max_concurrent === 1 && JSON.stringify(mrec?.scrub_env) === '["CLOUD_*"]', JSON.stringify(m).slice(0, 300));
waitRun('mcp-cap');

// ---------- lib/store.mjs: the lock is never taken from a holder that is still alive (B-L17)
const store = await import(new URL('file:///' + path.join(CORE, 'lib', 'store.mjs').replace(/\\/g, '/')).href);
const lk = path.join(T, 'locks', 'x.lock');
fs.mkdirSync(path.dirname(lk), { recursive: true });
fs.writeFileSync(lk, String(process.pid));
const old = new Date(Date.now() - 120_000); fs.utimesSync(lk, old, old);
let took = false, err = '';
try { store.withLock(lk, () => { took = true; }, { waitMs: 300, staleMs: 1000 }); } catch (e) { err = e.message; }
ok('L1 an old lock whose holder is alive is not taken over (the waiter gives up instead)', !took && /could not get the lock/.test(err), err);
const dead = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
fs.writeFileSync(lk, String(dead));
took = false;
try { store.withLock(lk, () => { took = true; }, { waitMs: 1000, staleMs: 60_000 }); } catch (e) { err = e.message; }
ok('L2 a lock whose holder is gone is taken over at once', took && !fs.existsSync(lk), err);

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);

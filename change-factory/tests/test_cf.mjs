// Tests for change-factory's helper (scripts/cf.mjs): the event log, the gates, trust, the hook.
// Run: node change-factory/tests/test_cf.mjs
// Needs Node 20+ and git 2.38+. Calls no model and spends nothing: a stand-in plays OpenCode (the
// bridge runs `<opencode> run ...`, and with node as the binary that runs the file named `run` in
// the worker's folder) and another plays the test command. Every record goes under a temp folder
// (CHANGE_FACTORY_HOME, OC_BRIDGE_HOME), never the real home folder. The repository is synthetic.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const P = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CF = path.join(P, 'scripts', 'cf.mjs');
const OCB = path.join(P, 'bridge', 'oc.mjs');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-test-'));
const HOME = path.join(T, 'cf-home');
const BHOME = path.join(T, 'bridge-home');
const STUB_CTL = path.join(T, 'stub.json');
const CI_CTL = path.join(T, 'ci.json');
const FAKECI = path.join(T, 'fake-ci.cjs');
const ENV = { ...process.env, CHANGE_FACTORY_HOME: HOME, OC_BRIDGE_HOME: BHOME, OC_BRIDGE_OPENCODE: process.execPath, STUB_CTL };
delete ENV.OPENCODE_CONFIG; delete ENV.OPENCODE_CONFIG_CONTENT;

let pass = 0; const failed = [];
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log('PASS ' + name); } else { failed.push(name); console.log('FAIL ' + name + (detail ? '   [' + String(detail).slice(0, 400) + ']' : '')); } };
const repo = path.join(T, 'repo');
const sh = (args, { cwd = repo, input } = {}) => {
  try { return { code: 0, out: execFileSync(process.execPath, [CF, ...args], { cwd, env: ENV, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
};
const J = (r) => { try { return JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { return null; } };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (rel, text, base = repo) => { const p = path.join(base, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const commit = (cwd, msg) => { git(cwd, 'add', '-A'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', msg); return git(cwd, 'rev-parse', 'HEAD'); };
const merge = (cwd, branch) => { try { git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'merge', '--no-ff', '-q', '-m', 'merge ' + branch, branch); return true; } catch { return false; } };

// The hook, as Claude Code calls it: the tool call as JSON on stdin.
const hook = (input, cwd = repo) => { const x = sh(['hook'], { cwd, input: typeof input === 'string' ? input : JSON.stringify(input) }); try { return x.out.trim() ? JSON.parse(x.out) : {}; } catch { return { raw: x.out }; } };
const shellLine = (args) => `node "${CF}" ` + args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ');
// An owner record goes through the hook's prompt first, as it would in a session; then it runs.
const viaHook = (args, { cwd = repo } = {}) => { hook({ tool_name: 'Bash', tool_input: { command: shellLine(args) }, cwd }, cwd); return sh(args, { cwd }); };

// The stand-ins.
const STUB = `const fs = require('fs'); let m = 'ok'; try { m = JSON.parse(fs.readFileSync(process.env.STUB_CTL, 'utf8')).mode; } catch {}
if (m === '429') { console.error('Error: 429 Too Many Requests: rate limit reached'); process.exit(1); }
console.log('stand-in worker ran');`;
const stub = (mode) => fs.writeFileSync(STUB_CTL, JSON.stringify({ mode }));
fs.writeFileSync(FAKECI, `const fs = require('fs'); const [sha, report] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(${JSON.stringify(CI_CTL)}, 'utf8')); fs.writeFileSync(report, JSON.stringify(r));
process.exit(Object.values(r).every((v) => v === 'pass') ? 0 : 1);`);
const ci = (suites) => fs.writeFileSync(CI_CTL, JSON.stringify(suites));
const waitRun = (id) => { try { execFileSync(process.execPath, [OCB, 'wait', id, '--stall-min', '2'], { env: ENV, stdio: 'ignore' }); } catch { /* exit 1: failed */ } };
const addWorktree = (dir, branch) => { git(repo, 'worktree', 'add', '-q', dir, branch); fs.writeFileSync(path.join(dir, 'run'), STUB); };
const PROMPT = path.join(T, 'prompt.md'); fs.writeFileSync(PROMPT, '# round prompt\n');

// ---------- a synthetic project
fs.mkdirSync(repo, { recursive: true });
git(repo, 'init', '-q', '-b', 'main');
fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '\nrun\n');
write('src/a.js', 'export const a = 1;\nexport const b = 2;\n');
write('src/shared.js', 'export const flags = {\n};\n');
write('src/t.js', 'one\ntwo\nthree\nfour\nfive\n');
write('tests/a.test.js', 'test\n');
write('gen/out.txt', 'generated v1\n');
write('.gitignore', 'change-factory/\n');
const base = commit(repo, 'base');
const cfg = {
  version: 1, project: 'toy', main_branch: 'main', worktree_root: '../wt', time_zone: 'UTC',
  conductor_model: 'opus',
  roles: {
    brief_writer: { via: 'subagent', model: 'opus' },
    worker: { via: 'opencode', model: 'prov/worker-1', escalate_after: 2 },
    worker_escalation: { via: 'subagent', model: 'opus' },
    round_reviewer: { via: 'subagent', model: 'opus', fallback: ['sonnet'], on_fallback: 'ok' },
    stream_red_team: { via: 'subagent', model: 'fable', fallback: ['opus'], on_fallback: 'owed_pass' },
    research: { via: 'subagent', model: 'opus' },
  },
  independence: { reviewer_not_author: true, red_team_not_reviewer: true, red_team_not_author: true },
  providers: { prov: { max_concurrent: 1 } },
  machine: { warn_below_free_gb: 1.0, reserve_gb: 0.3, per_worker_gb: 0.25 },
  budgets: { max_rounds_per_stream: 3, max_worker_runs: 30, max_ci_runs: 30, max_red_team_passes: 6 },
  tests: { mode: 'ci', stream_cmd: 'node -e 1', combined_cmd: 'node -e 1', ci_cmd: `node ${FAKECI} {sha} {report}`, report: 'json', required_suites: ['unit', 'api', 'golden'], regenerated_on_integration: ['golden'] },
  generated: { commands: ['node -e "require(\'fs\').writeFileSync(\'gen/out.txt\',\'generated v2\\n\')"'], paths: ['gen/**'] },
  test_paths: ['tests/**'],
  docs_paths: ['docs/cf/**'],
  worker_rules: 'change-factory/worker-rules.json',
  worker_env_scrub: ['CLOUD_*'],
  flags: true,
  hook_mode: 'ask',
  deploy_units: [
    { name: 'app', kind: 'command', touched_by: ['src/**'], cmd: 'npm run deploy', rollback_lookup: '', rollback: 'redeploy the previous release', verify: '', after: [] },
    { name: 'docs', kind: 'manual', touched_by: ['docs/site/**'], cmd: '', rollback: 'revert the page', verify: '', after: ['app'] },
  ],
  push_cmd: 'git push origin main',
  quiet_window_cmd: '',
  research_runner: '',
};
write('change-factory.config.json', JSON.stringify(cfg, null, 2));
const runBase = commit(repo, 'config');
const WT = path.join(T, 'wt'); fs.mkdirSync(WT);
const wt1 = path.join(WT, 's1'), wt2 = path.join(WT, 's2'), wti = path.join(WT, 'int');
git(repo, 'branch', 's1', runBase); addWorktree(wt1, 's1');
git(repo, 'branch', 's2', runBase); addWorktree(wt2, 's2');

// ---------- init writes the worker rules; trust
let r = sh(['init']);
ok('init writes the worker rules file from the shared rules plus the configured commands', r.code === 0 && fs.existsSync(path.join(repo, 'change-factory/worker-rules.json')), r.out);
const rulesText = fs.readFileSync(path.join(repo, 'change-factory/worker-rules.json'), 'utf8');
ok('the worker rules refuse the helper and the plugin home', /cf\.mjs/.test(rulesText) && /\.change-factory/.test(rulesText));
ok('Q-M3 the worker rules refuse the configured test command (it runs with CI credentials)', rulesText.includes(FAKECI.replace(/\\/g, '\\\\')), rulesText.slice(-600));

r = viaHook(['run', 'open', 'r1', '--integration', 'cf/int', '--session', 'A']);
ok('T1 an untrusted config is refused', r.code === 2 && /not accepted on this machine/.test(r.out), r.out);
r = sh(['trust']);
ok('T1 trust shows every command agents and the helper will run', r.code === 0 && /npm run deploy/.test(r.out) && /fake-ci/.test(r.out) && /generated v2/.test(r.out), r.out);
r = sh(['trust', '--yes']);
ok('Q-M2 trust --yes without the hook\'s prompt is refused (an owner record needs its token)', r.code === 2 && /prompt/.test(r.out), r.out);
r = viaHook(['trust', '--yes']);
ok('T1 trust --yes through the hook\'s prompt accepts it', r.code === 0 && J(r)?.accepted === true, r.out);
ok('Q-M2 accepting stores a guard snapshot in the home folder', fs.existsSync(path.join(HOME, 'guard')) && fs.readdirSync(path.join(HOME, 'guard')).length === 1);

// ---------- run, lease
r = sh(['run', 'open', 'r1', '--integration', 'cf/int', '--session', 'A']);
ok('Q-M2 run open without the hook\'s prompt is refused', r.code === 2 && /prompt/.test(r.out), r.out);
r = viaHook(['run', 'open', 'r1', '--integration', 'cf/int', '--session', 'A']);
ok('a run opens on the trusted config and takes the lease', r.code === 0 && J(r)?.base === runBase, r.out);
const L = ['--lease', 'A'];
r = sh(['stream', 'add', 's1', '--title', 'first', '--tier', 'high', '--ship', 'on']);
ok('L1 a write without the lease is refused', r.code === 2 && /lease/.test(r.out), r.out);
r = sh(['stream', 'add', 's1', '--title', 'first', '--tier', 'high', '--ship', 'on', '--lease', 'B']);
ok('L1 a write with another session\'s lease is refused', r.code === 2 && /held by A/.test(r.out), r.out);
r = sh(['lease', 'take', '--session', 'B']);
ok('L2 a second conductor cannot take the lease without --force', r.code === 2 && /held by A/.test(r.out), r.out);
r = sh(['lease', 'take', '--session', 'B', '--force']);
ok('L2 an explicit takeover is allowed and recorded', r.code === 0 && J(r)?.taken_from === 'A', r.out);
r = sh(['stream', 'add', 's1', '--title', 'first', '--tier', 'high', '--ship', 'on', ...L]);
ok('L2 after a takeover the old lease is refused', r.code === 2 && /held by B/.test(r.out), r.out);
const LB = ['--lease', 'B'];
r = sh(['stream', 'add', 's1', '--title', 'first', '--tier', 'high', '--ship', 'on', '--at', '2020-01-01', ...LB]);
ok('C1 no command takes a time: the helper stamps events', r.code === 2 && /unknown option --at/.test(r.out), r.out);
sh(['stream', 'add', 's1', '--title', 'first', '--tier', 'high', '--ship', 'on', ...LB]);
sh(['stream', 'add', 's2', '--title', 'second', '--tier', 'low', '--ship', 'on', ...LB]);
sh(['stream', 'add', 's3', '--title', 'third', '--tier', 'high', '--ship', 'off', ...LB]);
r = sh(['stream', 'add', 's4', '--title', 'x', '--tier', 'mid', '--ship', 'on', ...LB]);
ok('a tier that is not low or high is refused', r.code === 2, r.out);

// ---------- briefs and owner gates before dispatch
r = sh(['dispatch', 's1', '--role', 'worker', ...LB]);
ok('B1 a worker is refused for a stream the owner has not confirmed', r.code === 2 && /not confirmed/.test(r.out), r.out);
r = sh(['owner', 'confirm', 's1', '--tier', 'high', '--ship', 'on', ...LB]);
ok('Q-M2 an owner record made without the hook\'s prompt is refused', r.code === 2 && /prompt/.test(r.out), r.out);
r = viaHook(['owner', 'confirm', 's1', '--tier', 'low', '--ship', 'on', ...LB]);
ok('B-L12 owner confirm names the tier and ship mode it approves, and is refused when they differ from the stream', r.code === 2 && /tier/.test(r.out), r.out);
r = viaHook(['owner', 'confirm', 's1', ...LB]);
ok('B-L12 owner confirm without --tier and --ship is refused (the prompt must show what is approved)', r.code === 2 && /--tier/.test(r.out), r.out);
for (const [s, tier, ship] of [['s1', 'high', 'on'], ['s2', 'low', 'on'], ['s3', 'high', 'off']]) viaHook(['owner', 'confirm', s, '--tier', tier, '--ship', ship, ...LB]);
r = sh(['dispatch', 's1', '--role', 'worker', ...LB]);
ok('B2 a worker is refused before a brief is recorded', r.code === 2 && /no brief/.test(r.out), r.out);

const brief = (premise, { decisions = '- none', questions = '- none', unverified = '- none', owned = '- src/a.js\n- tests/**' } = {}) =>
  `# Brief\n\n## Premise\n\nstatus: ${premise}\nevidence: src/a.js:1 still sets a = 1\n\n## Items\n\n1. change a\n\n## Decisions I made\n\n${decisions}\n\n## Questions for the owner\n\n${questions}\n\n## Could not verify\n\n${unverified}\n\n## Owned paths\n\n${owned}\n\n## Off switch\n\nnone: ships on\n`;
write('briefs/s1.md', '# Brief\n\nno premise here\n', T);
r = sh(['brief', 'record', 's1', '--file', path.join(T, 'briefs/s1.md'), ...LB]);
ok('B3 a brief without a PREMISE section is refused', r.code === 2 && /Premise/.test(r.out), r.out);
write('briefs/s1.md', brief('holds').replace('evidence: src/a.js:1 still sets a = 1', 'evidence: it is fine'), T);
r = sh(['brief', 'record', 's1', '--file', path.join(T, 'briefs/s1.md'), ...LB]);
ok('B3 a premise without a file:line is refused', r.code === 2 && /file:line/.test(r.out), r.out);
write('briefs/s1.md', brief('holds').replace('## Could not verify\n\n- none\n\n', ''), T);
r = sh(['brief', 'record', 's1', '--file', path.join(T, 'briefs/s1.md'), ...LB]);
ok('B3 a brief without its three lists is refused', r.code === 2 && /Could not verify/.test(r.out), r.out);
write('briefs/s1.md', brief('changed'), T);
r = sh(['brief', 'record', 's1', '--file', path.join(T, 'briefs/s1.md'), ...LB]);
ok('B4 a changed premise is recorded and puts the stream in needs_owner', r.code === 0 && J(r)?.needs_owner === true, r.out);
r = sh(['dispatch', 's1', '--role', 'worker', ...LB]);
ok('B4 a worker is refused while the stream needs the owner', r.code === 2 && /needs the owner/.test(r.out), r.out);
viaHook(['owner', 'answer', 's1', '--text', 'go ahead with the new premise', ...LB]);
write('briefs/s2.md', brief('holds', { questions: '- should b be 3 or 4?', owned: '- src/a.js' }), T);
r = sh(['brief', 'record', 's2', '--file', path.join(T, 'briefs/s2.md'), ...LB]);
ok('B5 a brief with a question for the owner puts the stream in needs_owner', J(r)?.needs_owner === true, r.out);
viaHook(['owner', 'answer', 's2', '--text', '4', ...LB]);
// The two Q-L1 checks run marked-first since B-L1: once a stream needs the owner, only the owner's answer clears it.
write('briefs/s3.md', brief('holds', { owned: '- src/shared.js', decisions: '- kept the old file name (changes what is built: no)' }), T);
r = sh(['brief', 'record', 's3', '--file', path.join(T, 'briefs/s3.md'), ...LB]);
ok('Q-L1 a decision marked "changes what is built: no" does not stop the stream', r.code === 0 && J(r)?.needs_owner === false, r.out);
write('briefs/s3.md', brief('holds', { owned: '- src/shared.js', decisions: '- kept the old file name' }), T);
r = sh(['brief', 'record', 's3', '--file', path.join(T, 'briefs/s3.md'), ...LB]);
ok('Q-L1 a decision not marked "changes what is built: no" stops the stream (unmarked counts as yes)', J(r)?.needs_owner === true, r.out);
write('briefs/s3.md', brief('holds', { owned: '- src/shared.js', decisions: '- kept the old file name (changes what is built: no)' }), T);
r = sh(['brief', 'record', 's3', '--file', path.join(T, 'briefs/s3.md'), ...LB]);
ok('B-L1 re-recording a brief does not clear "needs owner": only the owner\'s answer does', r.code === 0 && J(r)?.needs_owner === true, r.out);
r = viaHook(['owner', 'answer', 's3', '--text', 'keep the old name', ...LB]);
ok('B-L1 the owner\'s answer clears it', r.code === 0, r.out);

// ---------- worker rules sampled at dispatch
const goodRules = fs.readFileSync(path.join(repo, 'change-factory/worker-rules.json'), 'utf8');
fs.writeFileSync(path.join(repo, 'change-factory/worker-rules.json'), JSON.stringify({ permission: { bash: { '*': 'allow', '*git push*': 'deny' } } }));
r = sh(['dispatch', 's1', '--role', 'worker', ...LB]);
ok('W1 a changed rules file makes the config untrusted, so no worker starts', r.code === 2 && /not accepted/.test(r.out), r.out);
r = viaHook(['trust', '--yes']);
ok('W1 the owner cannot accept rules that do not refuse a configured deploy command', r.code === 2 && /npm run deploy/.test(r.out), r.out);
fs.writeFileSync(path.join(repo, 'change-factory/worker-rules.json'), goodRules);

// ---------- the helper starts the worker itself (Q-M3)
r = sh(['dispatch', 's1', '--role', 'worker', '--prompt-file', PROMPT, ...LB]);
ok('Q-M3 a worker dispatch without the folder it works in is refused', r.code === 2 && /--dir/.test(r.out), r.out);
r = sh(['dispatch', 's1', '--role', 'worker', '--dir', wt1, ...LB]);
ok('Q-M3 a worker dispatch without its prompt file is refused', r.code === 2 && /--prompt-file/.test(r.out), r.out);
r = sh(['dispatch', 's1', '--role', 'worker', '--dir', T, '--prompt-file', PROMPT, ...LB]);
ok('Q-M3 a worker folder that is not a worktree of this repository is refused', r.code === 2 && /worktree/.test(r.out), r.out);
stub('429');
r = sh(['dispatch', 's1', '--role', 'worker', '--dir', wt1, '--prompt-file', PROMPT, ...LB]);
const d1 = J(r);
ok('W2 a worker dispatch gets a run id with stream, round and attempt', r.code === 0 && d1?.run_id === 'r1-s1-r1-a1' && d1?.rules && d1?.model === 'prov/worker-1', r.out);
ok('W2 the dispatch carries the environment names to scrub', JSON.stringify(d1?.scrub_env) === '["CLOUD_*"]', r.out);
const bstate = (id) => { try { return JSON.parse(fs.readFileSync(path.join(BHOME, 'runs', id, 'state.json'), 'utf8')); } catch { return null; } };
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const st1 = bstate('r1-s1-r1-a1');
ok('Q-M3 the helper started the run itself, with the trusted rules, the provider cap and the scrub list', st1?.rules_sha256 === sha(goodRules) && st1?.max_concurrent >= 1 && JSON.stringify(st1?.scrub_env) === '["CLOUD_*"]' && st1?.model === 'prov/worker-1', JSON.stringify(st1).slice(0, 300));
ok('Q-M3 the dispatch returns the wait command for a background shell', /oc\.mjs" wait r1-s1-r1-a1/.test(d1?.wait_command || ''), JSON.stringify(d1));
r = sh(['dispatch', 's2', '--role', 'worker', '--dir', wt2, '--prompt-file', PROMPT, ...LB]);
ok('W3 a second worker on a provider capped at 1 is refused', r.code === 2 && /provider "prov"/.test(r.out), r.out);
waitRun(d1.run_id);
r = sh(['result', d1.dispatch, '--outcome', 'done', ...LB]);
ok('Q-M3 a result the bridge record contradicts is refused (no new commit, the run hit a rate limit)', r.code === 2 && /rate_limited/.test(r.out), r.out);
r = sh(['result', d1.dispatch, ...LB]);
ok('W4 a rate-limited attempt is recorded from the bridge\'s own record', r.code === 0 && J(r)?.outcome === 'rate_limited', r.out);
stub('ok');
r = sh(['dispatch', 's1', '--role', 'worker', '--dir', wt1, '--prompt-file', PROMPT, ...LB]);
const d1b = J(r);
ok('W4 a rate-limited attempt is not a round: the next is round 1 attempt 2', d1b?.run_id === 'r1-s1-r1-a2', r.out);

// stream s1 does work on its branch
write('src/a.js', 'export const a = 10;\nexport const b = 2;\n', wt1);
const s1h1 = commit(wt1, 's1 round 1');
waitRun(d1b.run_id);
const sf = path.join(BHOME, 'runs', d1b.run_id, 'state.json');
const keep = fs.readFileSync(sf, 'utf8');
fs.writeFileSync(sf, JSON.stringify({ ...JSON.parse(keep), rules_sha256: null }));
r = sh(['result', d1b.dispatch, ...LB]);
ok('Q-M3 a worker run without the trusted rules (started some other way) is not counted', r.code === 2 && /rules/.test(r.out), r.out);
fs.writeFileSync(sf, keep);
r = sh(['result', d1b.dispatch, ...LB]);
ok('W5 a finished worker round records the head the helper reads from the branch', r.code === 0 && J(r)?.outcome === 'done' && J(r)?.head === s1h1, r.out);

// ---------- CI only on a reviewed head
r = sh(['dispatch', 's1', '--role', 'ci', '--target', s1h1, ...LB]);
ok('CI1 CI on a head no review has passed is refused', r.code === 2 && /not been reviewed/.test(r.out), r.out);

// ---------- reviews: verdict read from the file, independence
r = sh(['dispatch', 's1', '--role', 'round_reviewer', ...LB]);
const rv1 = J(r);
ok('R1 a round review is dispatched on the stream head', r.code === 0 && rv1?.target === s1h1, r.out);
write('reviews/s1-1.md', 'MERGEABLE, trust me\n', T);
r = sh(['result', rv1.dispatch, '--outcome', 'done', '--file', path.join(T, 'reviews/s1-1.md'), ...LB]);
ok('R2 a review whose first line is not a verdict is refused', r.code === 2 && /first line/.test(r.out), r.out);
write('reviews/s1-1.md', 'verdict: CHANGES NEEDED\n\nM1 a is wrong\n', T);
r = sh(['result', rv1.dispatch, '--outcome', 'done', '--file', path.join(T, 'reviews/s1-1.md'), ...LB]);
ok('R2 the helper reads the verdict from the file and writes the trailer from the dispatch', r.code === 0 && J(r)?.verdict === 'CHANGES NEEDED' && /Reviewed-by: opus \(round_reviewer\)/.test(J(r)?.trailer || ''), r.out);
r = sh(['dispatch', 's1', '--role', 'round_reviewer', '--target', s1h1, '--model', 'sonnet', ...LB]);
ok('B-L11 a head that already has a verdict is not reviewed again (no verdict shopping)', r.code === 2 && /already/.test(r.out), r.out);

// round 2 fails too -> escalation after 2 failed rounds
const dW2 = J(sh(['dispatch', 's1', '--role', 'worker', '--dir', wt1, '--prompt-file', PROMPT, ...LB]));
ok('a failed round leads to round 2', dW2?.run_id === 'r1-s1-r2-a1', JSON.stringify(dW2));
write('src/a.js', 'export const a = 11;\nexport const b = 2;\n', wt1);
const s1h2 = commit(wt1, 's1 round 2');
waitRun(dW2.run_id);
sh(['result', dW2.dispatch, ...LB]);
const rv2 = J(sh(['dispatch', 's1', '--role', 'round_reviewer', ...LB]));
ok('(set-up) round 2 is reviewed at its head', rv2?.target === s1h2, JSON.stringify(rv2));
write('reviews/s1-2.md', 'verdict: CHANGES NEEDED\n', T);
sh(['result', rv2.dispatch, '--outcome', 'done', '--file', path.join(T, 'reviews/s1-2.md'), ...LB]);
r = sh(['dispatch', 's1', '--role', 'worker', '--dir', wt1, '--prompt-file', PROMPT, ...LB]);
ok('E1 after escalate_after failed rounds the worker role is refused', r.code === 2 && /worker_escalation/.test(r.out), r.out);
r = sh(['dispatch', 's1', '--role', 'worker_escalation', '--dir', wt1, ...LB]);
const dE = J(r);
ok('E1 the escalation role is allowed', r.code === 0 && dE?.model === 'opus', r.out);
r = sh(['dispatch', 's2', '--role', 'worker_escalation', '--dir', wt2, ...LB]);
ok('B-L4 worker_escalation is refused before escalate_after failed rounds', r.code === 2 && /escalate_after/.test(r.out), r.out);
write('src/a.js', 'export const a = 12;\nexport const b = 2;\n', wt1);
const s1h3 = commit(wt1, 's1 round 3 by escalation');
r = sh(['result', dE.dispatch, '--outcome', 'done', '--head', s1h2, ...LB]);
ok('a --head that is not the branch head is refused', r.code === 2 && /branch/.test(r.out), r.out);
sh(['result', dE.dispatch, '--outcome', 'done', '--head', s1h3, ...LB]);
r = sh(['dispatch', 's1', '--role', 'round_reviewer', ...LB]);
ok('I1 a reviewer on the model that wrote the round is refused', r.code === 2 && /wrote/.test(r.out), r.out);
r = sh(['dispatch', 's1', '--role', 'round_reviewer', '--model', 'haiku', ...LB]);
ok('I2 a model that is neither the role\'s model nor in its fallback list is refused', r.code === 2 && /fallback/.test(r.out), r.out);
r = sh(['dispatch', 's1', '--role', 'round_reviewer', '--model', 'sonnet', ...LB]);
const rv3 = J(r);
ok('I3 the fallback model is allowed', r.code === 0 && rv3?.model === 'sonnet', r.out);
write('reviews/s1-3.md', 'verdict: MERGEABLE\n', T);
sh(['result', rv3.dispatch, '--outcome', 'done', '--file', path.join(T, 'reviews/s1-3.md'), ...LB]);
r = sh(['dispatch', 's1', '--role', 'worker_escalation', '--dir', wt1, ...LB]);
ok('BU1 the round budget (3 per stream) refuses a 4th round', r.code === 2 && /max_rounds_per_stream/.test(r.out), r.out);

// The review file is committed on the stream branch: the branch moves, the code does not (Q-M4).
write('docs/cf/s1/REVIEW-3.md', 'verdict: MERGEABLE\n', wt1);
const s1doc = commit(wt1, 's1: review 3');
r = sh(['dispatch', 's1', '--role', 'ci', ...LB]);
const c1 = J(r);
ok('Q-M4 a commit of record files only does not move the reviewed head: CI runs on the code head', r.code === 0 && c1?.target === s1h3, r.out);
ok('CI2 CI on the reviewed head is allowed, with the exact commit filled in', r.code === 0 && (c1?.command || '').includes(s1h3) && !(c1?.command || '').includes('{sha}'), r.out);
r = sh(['result', c1.dispatch, '--outcome', 'done', ...LB]);
ok('Q-M7 a test result before the helper ran the test is refused', r.code === 2 && /test start/.test(r.out), r.out);
r = sh(['result', c1.dispatch, '--outcome', 'done', '--suite', 'unit=pass', ...LB]);
ok('Q-M7 suites cannot be typed in: they are read from the run', r.code === 2 && /--suite/.test(r.out), r.out);
ci({ unit: 'pass', api: 'pass', golden: 'fail' });
r = sh(['test', 'start', c1.dispatch, ...LB]);
ok('Q-M7 the helper starts the test run itself, on the exact commit, and returns its wait command', r.code === 0 && J(r)?.sha === s1h3 && /test wait/.test(J(r)?.wait_command || ''), r.out);
r = sh(['test', 'wait', c1.dispatch]);
ok('Q-M7 test wait blocks until the run ends; exit 1 when a suite failed', r.code === 1, r.out);
r = sh(['result', c1.dispatch, ...LB]);
ok('Q-M7 the result is read from the run\'s own report, per suite', r.code === 0 && J(r)?.suites?.unit === 'pass' && J(r)?.suites?.golden === 'fail', r.out);

// stream s2: another edit of the same line (a planted conflict)
const dS2 = J(sh(['dispatch', 's2', '--role', 'worker', '--dir', wt2, '--prompt-file', PROMPT, ...LB]));
write('src/a.js', 'export const a = 20;\nexport const b = 4;\n', wt2);
const s2h = commit(wt2, 's2 round 1');
waitRun(dS2.run_id);
sh(['result', dS2.dispatch, ...LB]);
const rvS2 = J(sh(['dispatch', 's2', '--role', 'round_reviewer', ...LB]));
write('reviews/s2-1.md', 'verdict: MERGEABLE\n', T);
sh(['result', rvS2.dispatch, '--outcome', 'done', '--file', path.join(T, 'reviews/s2-1.md'), ...LB]);
const runTests = (d, lease = LB) => { sh(['test', 'start', d, ...lease]); sh(['test', 'wait', d]); return sh(['result', d, ...lease]); };
const cS2a = J(sh(['dispatch', 's2', '--role', 'ci', '--target', s2h, ...LB]));
ci({ unit: 'pass', api: 'fail', golden: 'pass' }); runTests(cS2a.dispatch);

// ---------- integration branch
git(repo, 'branch', 'cf/int', runBase);
addWorktree(wti, 'cf/int');
merge(wti, 's1');
const m1 = git(wti, 'rev-parse', 'HEAD');
r = sh(['merge', 'record', 's1', '--commit', m1, ...LB]);
ok('M1 a reviewed, green stream\'s merge is recorded (its branch tip is a record commit on the reviewed code)', r.code === 0 && J(r)?.conflicts?.length === 0 && J(r)?.head === s1h3, r.out);
ok('Q-M5 a suite rebuilt on the integration branch (golden) does not block a stream\'s merge', r.code === 0, r.out);
ok('M1 a stream is red-team eligible by tier', J(r)?.eligible?.includes('tier high'), r.out);

const ok2 = merge(wti, 's2');
ok('(set-up) the planted conflict happens', !ok2);
write('src/a.js', 'export const a = 12;\nexport const b = 4;\n', wti);
const m2 = commit(wti, 'merge s2 (conflict: kept a from s1, b from s2)');
r = sh(['merge', 'record', 's2', '--commit', m2, ...LB]);
ok('M2 a merge of a stream without green CI on its head is refused', r.code === 2 && /api/.test(r.out), r.out);
const cS2b = J(sh(['dispatch', 's2', '--role', 'ci', '--target', s2h, ...LB]));
ci({ unit: 'pass', api: 'pass', golden: 'pass' }); runTests(cS2b.dispatch);
r = sh(['merge', 'record', 's2', '--commit', m2, ...LB]);
ok('M3 a merge with a resolved conflict is recorded with the files and makes a low-tier stream eligible', r.code === 0 && J(r)?.conflicts?.includes('src/a.js') && J(r)?.eligible?.some((e) => /conflict/.test(e)), r.out);
r = sh(['merge', 'record', 's1', '--commit', base, ...LB]);
ok('M4 a commit that is not a merge of the stream\'s tested head is refused', r.code === 2, r.out);

// lane check
r = sh(['lane', 's2', ...LB]);
ok('LN1 lane: a stream inside its owned paths is clean', r.code === 0 && J(r)?.outside?.length === 0, r.out);

// ---------- commit kinds on the integration branch
const head = () => git(wti, 'rev-parse', 'HEAD');
write('src/a.js', 'export const a = 13;\nexport const b = 4;\n', wti);
const bad = commit(wti, 'conductor: tweak');
r = sh(['commit', 'record', '--kind', 'generated', '--commit', bad, ...LB]);
ok('K1 a conductor commit called generated that touches source is refused', r.code === 2 && /src\/a\.js/.test(r.out), r.out);
r = sh(['dispatch', 'integration', '--role', 'ci', '--target', head(), ...LB]);
ok('K2 combined CI is refused while the integration branch holds a commit nobody accounted for', r.code === 2 && /not accounted for/.test(r.out) && r.out.includes(bad.slice(0, 10)), r.out);
git(wti, 'reset', '-q', '--hard', 'HEAD~1');
// a fix goes through a worker dispatched onto the integration branch
r = sh(['dispatch', 's2', '--role', 'worker', '--on', 'integration', '--dir', wt2, '--prompt-file', PROMPT, ...LB]);
ok('a fix on the integration branch must run in the integration worktree', r.code === 2 && /cf\/int/.test(r.out), r.out);
r = sh(['dispatch', 's2', '--role', 'worker', '--on', 'integration', '--dir', wti, '--prompt-file', PROMPT, ...LB]);
const dFix = J(r);
ok('K3 a worker can be dispatched onto the integration branch for a merged stream', r.code === 0 && dFix?.dir === 'integration' && dFix?.run_id === 'r1-s2-r2-a1', r.out);
write('src/a.js', 'export const a = 13;\nexport const b = 4;\n', wti);
const fixH = commit(wti, 'fix for s2 on the integration branch');
waitRun(dFix.run_id);
r = sh(['result', dFix.dispatch, ...LB]);
ok('K3 its commits are recorded as a fix range that needs a review', r.code === 0 && J(r)?.fix_commits?.length === 1 && J(r)?.needs_review === true, r.out);

// ---------- combined CI needs every fix reviewed and regenerate at the current head
r = sh(['dispatch', 'integration', '--role', 'ci', '--target', head(), ...LB]);
ok('G1 combined CI is refused while a fix is unreviewed', r.code === 2 && /unreviewed/.test(r.out), r.out);
const rvF = J(sh(['dispatch', 's2', '--role', 'round_reviewer', ...LB]));
ok('G1 the review of the fix targets the fix head', rvF?.target === fixH, JSON.stringify(rvF));
write('reviews/fix-1.md', 'verdict: MERGEABLE\n', T);
sh(['result', rvF.dispatch, '--outcome', 'done', '--file', path.join(T, 'reviews/fix-1.md'), ...LB]);
r = sh(['dispatch', 'integration', '--role', 'ci', '--target', head(), ...LB]);
ok('G2 combined CI is refused without regenerate at this head', r.code === 2 && /regenerate/.test(r.out), r.out);
r = sh(['regenerate', ...LB]);
ok('G3 regenerate runs the commands and reports a dirty tree', r.code === 1 && J(r)?.clean === false && J(r)?.changed?.includes('gen/out.txt'), r.out);
const genC = commit(wti, 'regenerate');
r = sh(['commit', 'record', '--kind', 'generated', '--commit', genC, ...LB]);
ok('K4 a generated commit touching only generated paths is recorded', r.code === 0, r.out);
r = sh(['regenerate', ...LB]);
ok('G3 regenerate on a clean tree records the head', r.code === 0 && J(r)?.clean === true, r.out);
write('docs/cf/int/NOTES.md', 'notes\n', wti);
commit(wti, 'record: notes');
r = sh(['dispatch', 'integration', '--role', 'ci', '--target', head(), ...LB]);
const ci1 = J(r);
ok('G4 combined CI is allowed after regenerate at this code head (a record commit on top changes nothing)', r.code === 0 && ci1?.target === genC, r.out);
ci({ unit: 'pass', api: 'fail', golden: 'pass' }); runTests(ci1.dispatch);
write('tests/a.test.js', 'test fixed\n', wti);
const tfix = commit(wti, 'conductor: test-only flake fix');
r = sh(['commit', 'record', '--kind', 'test_only', '--commit', tfix, ...LB]);
ok('K5 a test-only conductor commit is recorded', r.code === 0, r.out);
sh(['regenerate', ...LB]);
r = sh(['dispatch', 'integration', '--role', 'ci', ...LB]);
ok('Q-M4 combined CI is refused while a conductor\'s test-only commit is unreviewed', r.code === 2 && /test_only/.test(r.out), r.out);
r = sh(['dispatch', 'integration', '--role', 'round_reviewer', '--target', tfix, ...LB]);
ok('Q-M4 a conductor commit is not reviewed on the conductor\'s own model', r.code === 2 && /wrote/.test(r.out), r.out);
r = sh(['dispatch', 'integration', '--role', 'round_reviewer', '--target', tfix, '--model', 'sonnet', ...LB]);
const rvT = J(r);
ok('Q-M4 a conductor commit is reviewed on another model', r.code === 0 && rvT?.target === tfix, r.out);
write('reviews/tfix.md', 'verdict: MERGEABLE\n', T);
sh(['result', rvT.dispatch, '--outcome', 'done', '--file', path.join(T, 'reviews/tfix.md'), ...LB]);
const ci2 = J(sh(['dispatch', 'integration', '--role', 'ci', ...LB]));
ok('(set-up) combined CI after the review', !!ci2?.dispatch, JSON.stringify(ci2));
ci({ api: 'pass' }); runTests(ci2.dispatch);

// ---------- red team, owed pass, release gates
r = sh(['release-check']);
ok('RL1 release refused: CI on the head is not complete (unit only on an older head)', r.code === 1 && /unit/.test(r.out), r.out);
r = viaHook(['owner', 'ci-compose', '--head', head(), '--from', `${ci1.dispatch}:unit`, '--from', `${ci1.dispatch}:golden`, '--from', `${ci2.dispatch}:api`, ...LB]);
ok('RL2 an owner composition across heads is recorded', r.code === 0, r.out);
r = sh(['release-check']);
ok('RL3 release refused: a high-tier ON stream has no red team on its merge', r.code === 1 && /s1/.test(r.out) && /red team/.test(r.out), r.out);
r = sh(['dispatch', 's1', '--role', 'stream_red_team', '--model', 'sonnet', ...LB]);
ok('I4 a red team on a model not in its role list is refused', r.code === 2, r.out);
r = sh(['dispatch', 's1', '--role', 'stream_red_team', '--model', 'opus', ...LB]);
const rt1 = J(r);
ok('I5 a red team falling back onto an author\'s model is allowed only as an owed pass', r.code === 0 && rt1?.owed === true && rt1?.target === m1, r.out);
ok('Q-M6 the red team dispatch records the integration head it reads', rt1?.integration_head === head(), r.out);
write('reviews/s1-rt.md', 'verdict: MERGEABLE\n', T);
sh(['result', rt1.dispatch, '--outcome', 'done', '--file', path.join(T, 'reviews/s1-rt.md'), ...LB]);
const rt2 = J(sh(['dispatch', 's2', '--role', 'stream_red_team', ...LB]));
write('reviews/s2-rt.md', 'verdict: MERGEABLE\n', T);
sh(['result', rt2.dispatch, '--outcome', 'done', '--file', path.join(T, 'reviews/s2-rt.md'), ...LB]);
r = sh(['dispatch', 's2', '--role', 'stream_red_team', ...LB]);
ok('Q-M6 a second red team for a cleared stream is refused (one per stream unless it went stale)', r.code === 2 && /not due/.test(r.out), r.out);
r = sh(['release-check']);
ok('RL4 release refused while an ON stream has an owed pass', r.code === 1 && /owed/.test(r.out), r.out);
r = viaHook(['owner', 'waive', 's1', '--what', 'owed', '--why', 'owner accepts the stand-in pass', ...LB]);
ok('RL5 an owner waiver is recorded', r.code === 0, r.out);
r = sh(['release-check']);
const rc = J(r);
ok('RL6 release-check passes and prints the ask per unit, rollback first', r.code === 0 && rc?.units?.[0]?.name === 'app' && /^rollback/i.test(rc?.units?.[0]?.ask?.[0] || ''), r.out);
ok('RL6 a unit no merge touched is not asked for', !rc?.units?.some((u) => u.name === 'docs'), r.out);
ok('RL7 a stream that was not merged is listed as not in this release', rc?.not_in_release?.includes('s3'), r.out);
r = viaHook(['owner', 'switch-on', 's3', ...LB]);
ok('SW1 switch-on of a stream that was never merged is refused', r.code === 2, r.out);

// ---------- deploy results and finishing
sh(['deploy', 'record', 'app', '--result', 'failed', ...LB]);
r = sh(['finish-check']);
ok('F1 main does not move after a failed unit', r.code === 1 && /app/.test(r.out), r.out);
r = viaHook(['owner', 'merge-without', 'app', '--why', 'deploy later', ...LB]);
r = sh(['finish-check']);
ok('F2 after the owner records merge-without, finish is allowed', r.code === 0, r.out);
write('src/a.js', 'main moved\n');
commit(repo, 'someone else on main');
r = sh(['finish-check']);
ok('F3 finish refused when main moved since the base', r.code === 1 && /moved/.test(r.out), r.out);

// ---------- carry-over register outlives the run
r = sh(['carry', 'add', 's3', '--kind', 'switch-on-condition', '--text', 'red team before the flag turns on', ...LB]);
ok('CA1 a carry item is added', r.code === 0, r.out);
r = viaHook(['run', 'open', 'r2', '--integration', 'cf/int2', '--session', 'C']);
ok('CA2 a second run is refused while one is open', r.code === 2 && /r1 is open/.test(r.out), r.out);

// ---------- reconcile: a dispatch whose result was lost
const lost = J(sh(['dispatch', 's3', '--role', 'brief_writer', '--expect', path.join(T, 'reviews/s3-finding.md'), ...LB]));
write('reviews/s3-finding.md', 'finding\n', T);
r = sh(['reconcile']);
ok('RC1 reconcile reports a dispatch that ran and whose result was lost', r.code === 0 && J(r)?.open_dispatches?.some((d) => d.dispatch === lost?.dispatch && /result lost/.test(d.state)), r.out);
const dX = J(sh(['dispatch', 's3', '--role', 'brief_writer', '--expect', path.join(T, 'reviews/s3-x.md'), ...LB]));
write('reviews/s3-y.md', 'another file\n', T);
r = sh(['result', dX.dispatch, '--outcome', 'done', '--file', path.join(T, 'reviews/s3-y.md'), ...LB]);
ok('B-L11 a result file other than the dispatch\'s --expect is refused', r.code === 2 && /expect/.test(r.out), r.out);

// ---------- status table
r = sh(['status']);
ok('S1 status renders one row per stream', r.code === 0 && /\| s1 \|/.test(r.out) && /\| s2 \|/.test(r.out) && /\| s3 \|/.test(r.out), r.out);
ok('S1 status shows owed passes and the waiver', /owed/.test(r.out) && /waived/.test(r.out), r.out);

// ---------- capacity: the machine guard would have allowed the real run it comes from
r = sh(['capacity', '--free-gb', '1.4']);
ok('MG1 at 1.4 GB free four workers are allowed', J(r)?.workers === 4 && J(r)?.warn === false, r.out);
r = sh(['capacity', '--free-gb', '0.4']);
ok('MG2 on a nearly full machine one worker is still allowed, with a warning', J(r)?.workers === 1 && J(r)?.warn === true, r.out);

// ---------- the log
const runs = path.join(HOME, 'projects');
const proj = fs.readdirSync(runs)[0];
const log = path.join(runs, proj, 'runs', 'r1', 'events.jsonl');
r = sh(['verify']);
ok('V1 verify passes on an untouched log', r.code === 0 && J(r)?.ok === true, r.out);
const lines = fs.readFileSync(log, 'utf8').split('\n');
const at = lines.findIndex((l) => l.includes('"first"'));
const savedLine = lines[at];
lines[at] = lines[at].replace('"first"', '"edited"');
fs.writeFileSync(log, lines.join('\n'));
r = sh(['verify']);
ok('V2 verify reports a hand edit in the middle of the log', r.code === 1 && r.out.includes(`line ${at + 2}`), r.out);
lines[at] = savedLine; fs.writeFileSync(log, lines.join('\n'));

// ---------- config edits: role changes keep trust, command changes lose it
r = sh(['role', 'set', 'round_reviewer', 'model', 'sonnet']);
ok('CF1 a role model change keeps the config accepted', r.code === 0 && J(sh(['trust']))?.trusted_now === true, r.out);
r = sh(['role', 'set', 'worker', 'model', 'not-a-provider-model']);
ok('CF2 an OpenCode role refuses a model that is not provider/model', r.code === 2, r.out);
r = sh(['role', 'set', 'stream_red_team', 'model', 'haiku']);
ok('Q-L5 the red team\'s model is the owner\'s change: refused without the hook\'s prompt', r.code === 2 && /prompt/.test(r.out), r.out);
const c2 = JSON.parse(fs.readFileSync(path.join(repo, 'change-factory.config.json'), 'utf8'));
c2.deploy_units[0].cmd = 'npm run ship';
fs.writeFileSync(path.join(repo, 'change-factory.config.json'), JSON.stringify(c2, null, 2));
r = sh(['status']);
ok('T2 a changed deploy command makes the config untrusted again', r.code === 2 && /not accepted/.test(r.out), r.out);

// ---------- the hook
let h = hook({ tool_name: 'Bash', tool_input: { command: 'cd x && npm   run deploy' }, cwd: repo });
ok('H1 a configured deploy command gets the owner prompt, naming the rollback', h.hookSpecificOutput?.permissionDecision === 'ask' && /rollback/i.test(h.hookSpecificOutput?.permissionDecisionReason || ''), JSON.stringify(h));
ok('Q-M2 the hook reads the trusted snapshot, not the project file: editing the config does not blind it', h.hookSpecificOutput?.permissionDecision === 'ask');
c2.deploy_units[0].cmd = 'npm run deploy';
fs.writeFileSync(path.join(repo, 'change-factory.config.json'), JSON.stringify(c2, null, 2));
h = hook({ tool_name: 'PowerShell', tool_input: { command: 'npm run deploy' }, cwd: repo });
ok('Q-M2 the PowerShell tool is guarded like Bash', h.hookSpecificOutput?.permissionDecision === 'ask', JSON.stringify(h));
h = hook({ tool_name: 'Bash', tool_input: { command: 'node "/x/scripts/cf.mjs" owner waive s1 --what owed' }, cwd: repo });
ok('H2 an owner record gets the owner prompt', h.hookSpecificOutput?.permissionDecision === 'ask', JSON.stringify(h));
for (const cmd of ['git push origin main', 'git -C ../x push', 'git push origin HEAD:main', 'git -c a=b push --force']) {
  h = hook({ tool_name: 'Bash', tool_input: { command: cmd }, cwd: repo });
  ok(`H3 a push in any form gets the owner prompt: ${cmd}`, h.hookSpecificOutput?.permissionDecision === 'ask', JSON.stringify(h));
}
for (const cmd of ['git merge --ff-only cf/int', `git -C "${repo}" reset --hard HEAD~1`, 'git branch -f main cf/int', 'git update-ref refs/heads/main abc']) {
  h = hook({ tool_name: 'Bash', tool_input: { command: cmd }, cwd: wt1 });
  ok(`Q-M2 moving main is guarded: ${cmd}`, h.hookSpecificOutput?.permissionDecision === 'ask', JSON.stringify(h));
}
h = hook({ tool_name: 'Bash', tool_input: { command: 'git status && npm test && git commit -m "fix the push handler"' }, cwd: wt1 });
ok('H4 ordinary work gets no decision', !h.hookSpecificOutput, JSON.stringify(h));
// B-M3: "moves main" is decided from the folder the git command acts on, asked of git, not from the chat's folder.
const dec = (command, cwd, tool = 'Bash') => hook({ tool_name: tool, tool_input: { command }, cwd }, cwd).hookSpecificOutput?.permissionDecision || 'none';
const elsewhere0 = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-other-'));
ok('B-M3 chat on the main checkout: a commit in a stream worktree (git -C) gets no decision', dec(`git -C "${wt1}" commit -m "s1: review 1"`, repo) === 'none');
ok('B-M3 chat on the main checkout: a merge in the integration worktree (git -C) gets no decision', dec(`git -C "${wti}" merge --no-ff s1`, repo) === 'none');
ok('B-M3 chat on the main checkout: cd <stream worktree> && git commit gets no decision', dec(`cd "${wt1}" && git add -A && git commit -m x`, repo) === 'none');
ok('B-M3 chat in <repo>/src: git merge moves main and asks', dec('git merge cf/int', path.join(repo, 'src')) === 'ask');
ok('B-M3 chat in an unrelated folder: git -C <repo> merge moves main and asks', dec(`git -C "${repo}" merge cf/int`, elsewhere0) === 'ask');
ok('B-M3 git fetch . cf/int:main from a worktree moves main and asks', dec('git fetch . cf/int:main', wt1) === 'ask');
ok('B-M3 chat on the main checkout: a commit there still asks', dec('git commit -m x', repo) === 'ask');
// B-L5, B-L6, B-L7
ok('B-L5 git.exe push asks', dec('git.exe push origin main', repo) === 'ask');
ok('B-L5 a quoted "git" push asks', dec('"git" push origin main', repo) === 'ask');
ok('B-L6 chat in an unrelated folder: a push in the repository asks', dec(`git -C "${repo}" push origin main`, elsewhere0) === 'ask');
ok('B-L6 chat in an unrelated folder: cd <repo> && a deploy asks', dec(`cd "${repo}" && npm run deploy`, elsewhere0) === 'ask');
ok('B-L7 a shell command on the helper\'s home folder asks', dec(`rm -rf "${HOME}/guard"`, repo) === 'ask');
ok('B-L7 a PowerShell command on the helper\'s home folder asks', dec(`Remove-Item -Recurse "${HOME}\\guard"`, repo, 'PowerShell') === 'ask');
ok('B-L7 the helper\'s own test wait, which names a file in its home folder, gets no decision', dec(`node "${CF}" test wait --state "${path.join(HOME, 'projects', 'x', 'state.json')}"`, repo) === 'none');
// B-M2, ask mode: a token left by a declined prompt is gone at the next guarded call.
const confirmS9 = ['owner', 'confirm', 's2', '--tier', 'low', '--ship', 'on', ...LB];
hook({ tool_name: 'Bash', tool_input: { command: shellLine(confirmS9) }, cwd: repo });
execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 3500)']);
dec('ls', repo);
r = sh(confirmS9);
ok('B-M2 ask mode: the token of a prompt that was not followed by its command is removed by the next guarded call', r.code === 2 && /prompt/.test(r.out), r.out);
fs.rmSync(elsewhere0, { recursive: true, force: true });
h = hook({ tool_name: 'Write', tool_input: { file_path: path.join(HOME, 'projects', 'x', 'events.jsonl') }, cwd: repo });
ok('H5 writing into the helper\'s home folder is denied', h.hookSpecificOutput?.permissionDecision === 'deny', JSON.stringify(h));
h = hook({ tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'change-factory.config.json') }, cwd: repo });
ok('Q-M2 an edit of a trusted project\'s config gets the owner prompt', h.hookSpecificOutput?.permissionDecision === 'ask', JSON.stringify(h));
h = hook({ tool_name: 'Write', tool_input: { file_path: path.join(repo, 'change-factory', 'worker-rules.json') }, cwd: wt1 });
ok('Q-M2 a write to a trusted project\'s worker rules gets the owner prompt', h.hookSpecificOutput?.permissionDecision === 'ask', JSON.stringify(h));
h = hook({ tool_name: 'Bash', tool_input: { command: 'npm run deploy' }, cwd: T });
ok('Q-M2 a session opened in a folder above the repository still gets the prompt', h.hookSpecificOutput?.permissionDecision === 'ask', JSON.stringify(h));
h = hook({ tool_name: 'Bash', tool_input: { command: 'npm run deploy' }, cwd: wt2 });
ok('Q-M2 a session in a worktree under the worktree folder gets the prompt', h.hookSpecificOutput?.permissionDecision === 'ask', JSON.stringify(h));
const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-elsewhere-'));
h = hook({ tool_name: 'Bash', tool_input: { command: 'npm run deploy' }, cwd: elsewhere });
ok('H6 in a folder unrelated to any trusted project a deploy command is left alone', !h.hookSpecificOutput, JSON.stringify(h));
h = hook({ tool_name: 'Bash', tool_input: { command: 'node cf.mjs trust --yes' }, cwd: elsewhere });
ok('H6 outside a project an owner-level helper command still gets the prompt', h.hookSpecificOutput?.permissionDecision === 'ask', JSON.stringify(h));
h = hook({ tool_name: 'Bash', tool_input: { command: 'npm run deploy' } });
ok('Q-M2 with no folder in the call, every trusted project is checked', h.hookSpecificOutput?.permissionDecision === 'ask', JSON.stringify(h));
h = hook({ tool_name: 'Bash', tool_input: { command: 'CHANGE_FACTORY_HOME=/tmp/x node cf.mjs status' }, cwd: elsewhere });
ok('Q-L4 a command that points the helper at another home folder gets the prompt', h.hookSpecificOutput?.permissionDecision === 'ask', JSON.stringify(h));
fs.writeFileSync(path.join(HOME, 'guard', 'zz-broken.json'), '{ not json');
h = hook({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: elsewhere });
ok('H7 a guard snapshot that cannot be read makes every shell command ask', h.hookSpecificOutput?.permissionDecision === 'ask', JSON.stringify(h));
fs.rmSync(path.join(HOME, 'guard', 'zz-broken.json'));
r = sh(['hook'], { input: 'not json' });
ok('H8 a hook input that is not JSON asks (the hook never fails open on its own error)', r.code === 0 && /"ask"/.test(r.out), r.out);
// hook_mode deny: the written fallback if the prompt does not reach the person
c2.hook_mode = 'deny';
fs.writeFileSync(path.join(repo, 'change-factory.config.json'), JSON.stringify(c2, null, 2));
r = viaHook(['trust', '--yes']);
h = hook({ tool_name: 'Bash', tool_input: { command: 'npm run deploy' }, cwd: repo });
ok('Q-M1 hook_mode deny refuses a deploy and gives the exact command for the owner to type', r.code === 0 && h.hookSpecificOutput?.permissionDecision === 'deny' && /npm run deploy/.test(h.hookSpecificOutput?.permissionDecisionReason || '') && /!/.test(h.hookSpecificOutput?.permissionDecisionReason || ''), JSON.stringify(h) + r.out);
// B-M2, deny mode: the refusal writes no token, and an owner record needs the owner at a terminal.
const tokDir = path.join(HOME, 'tokens');
const tokensBefore = fs.existsSync(tokDir) ? fs.readdirSync(tokDir).length : 0;
const answerS2 = ['owner', 'answer', 's2', '--text', 'still 4', ...LB];
h = hook({ tool_name: 'Bash', tool_input: { command: shellLine(answerS2) }, cwd: repo });
ok('B-M2 deny mode: the hook refuses an owner record and says to run it in the owner\'s own terminal', h.hookSpecificOutput?.permissionDecision === 'deny' && /own terminal/.test(h.hookSpecificOutput?.permissionDecisionReason || ''), JSON.stringify(h));
ok('B-M2 deny mode: the refusal writes no token', (fs.existsSync(tokDir) ? fs.readdirSync(tokDir).length : 0) <= tokensBefore);
r = sh(answerS2);
ok('B-M2 deny mode: the same owner record run again with no hook in between is refused', r.code === 2 && /terminal/.test(r.out), r.out);
r = viaHook(['trust', '--yes']);
ok('B-M2 deny mode: trust --yes with no terminal is refused even right after the hook saw it', r.code === 2 && /terminal/.test(r.out), r.out);
// Back to ask. The owner would do this in his own terminal; the test has none, so it writes what that yes
// writes (the guard snapshot's mode), then accepts the ask config through the hook as before.
c2.hook_mode = 'ask';
fs.writeFileSync(path.join(repo, 'change-factory.config.json'), JSON.stringify(c2, null, 2));
for (const g of fs.readdirSync(path.join(HOME, 'guard'))) { const gf = path.join(HOME, 'guard', g); fs.writeFileSync(gf, JSON.stringify({ ...JSON.parse(fs.readFileSync(gf, 'utf8')), hook_mode: 'ask' })); }
viaHook(['trust', '--yes']);
r = sh(['status']);
ok('(set-up) the config is accepted again', r.code === 0, r.out);
// P-M2: a config without hook_mode fails closed: it behaves as deny (ask only when set).
delete c2.hook_mode;
fs.writeFileSync(path.join(repo, 'change-factory.config.json'), JSON.stringify(c2, null, 2));
r = viaHook(['trust', '--yes']);
const tokensBeforeNoKey = fs.existsSync(tokDir) ? fs.readdirSync(tokDir).length : 0;
h = hook({ tool_name: 'Bash', tool_input: { command: shellLine(answerS2) }, cwd: repo });
ok('P-M2 no hook_mode key: the hook refuses an owner record as in deny mode', r.code === 0 && h.hookSpecificOutput?.permissionDecision === 'deny' && /own terminal/.test(h.hookSpecificOutput?.permissionDecisionReason || ''), JSON.stringify(h) + r.out);
ok('P-M2 no hook_mode key: the refusal writes no token', (fs.existsSync(tokDir) ? fs.readdirSync(tokDir).length : 0) <= tokensBeforeNoKey);
h = hook({ tool_name: 'Bash', tool_input: { command: 'npm run deploy' }, cwd: repo });
ok('P-M2 no hook_mode key: a deploy is refused, not asked', h.hookSpecificOutput?.permissionDecision === 'deny', JSON.stringify(h));
r = sh(answerS2);
ok('P-M2 no hook_mode key: an owner record from a non-terminal is refused', r.code === 2 && /terminal/.test(r.out), r.out);
// Back to ask, as above.
c2.hook_mode = 'ask';
fs.writeFileSync(path.join(repo, 'change-factory.config.json'), JSON.stringify(c2, null, 2));
for (const g of fs.readdirSync(path.join(HOME, 'guard'))) { const gf = path.join(HOME, 'guard', g); fs.writeFileSync(gf, JSON.stringify({ ...JSON.parse(fs.readFileSync(gf, 'utf8')), hook_mode: 'ask' })); }
viaHook(['trust', '--yes']);
r = sh(['status']);
ok('(set-up) the ask config is accepted again', r.code === 0, r.out);

// the plugin's own hook registration
const hj = JSON.parse(fs.readFileSync(path.join(P, 'hooks', 'hooks.json'), 'utf8'));
const pre = (hj.hooks?.PreToolUse || [])[0];
// (Since B-L18 the registration runs the helper through scripts/hook.mjs, which asks when the helper cannot load.)
ok('Q-M2 hooks.json guards Bash, PowerShell, Write, Edit, MultiEdit and NotebookEdit through the helper\'s hook', pre && ['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].every((t) => pre.matcher.split('|').includes(t)) && /scripts\/hook\.mjs" hook/.test(pre.hooks?.[0]?.command || ''), JSON.stringify(hj));
const broken = path.join(T, 'broken', 'scripts'); fs.mkdirSync(broken, { recursive: true });
for (const f of ['cf.mjs', 'hook.mjs']) { try { fs.copyFileSync(path.join(P, 'scripts', f), path.join(broken, f)); } catch { /* missing: the check below fails */ } }
let bh;
try { bh = execFileSync(process.execPath, [path.join(broken, 'hook.mjs'), 'hook'], { env: ENV, encoding: 'utf8', input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }), stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { bh = 'exit ' + e.status + ' ' + String(e.stderr || ''); }
ok('B-L18 the hook asks when the helper cannot load (a missing lib or bridge file)', /"permissionDecision":\s*"ask"/.test(bh), bh);
const mj = JSON.parse(fs.readFileSync(path.join(P, '.mcp.json'), 'utf8'));
ok('Q-M3 the plugin\'s bridge server offers no start tool (the helper starts workers)', /status/.test(mj.mcpServers?.['oc-bridge']?.env?.OC_BRIDGE_TOOLS || '') && !/start/.test(mj.mcpServers?.['oc-bridge']?.env?.OC_BRIDGE_TOOLS || ''), JSON.stringify(mj));

// SessionStart: a compacted or resumed chat is told the run is open
r = sh(['session-start'], { input: JSON.stringify({ cwd: repo, source: 'compact' }) });
ok('Q-L2 a session start in the project names the open run and the resume step', r.code === 0 && /r1/.test(r.out) && /resume/i.test(r.out), r.out);

// ---------- closing the run; the carry register reaches the next one
r = sh(['run', 'close', ...LB]);
ok('a run closes', r.code === 0, r.out);
r = viaHook(['run', 'open', 'r2', '--integration', 'cf/int2', '--session', 'C']);
ok('CA3 a new run lists the open carry items first', r.code === 0 && /red team before the flag/.test(r.out), r.out);
const LC = ['--lease', 'C'];
const base2 = J(r)?.base;

// ---------- run r2: a conflict only in generated files, the red-team loop, a verdict gone stale
const brief2 = (owned) => brief('holds', { owned }).replace('src/a.js:1', 'src/t.js:1');
const drive = (name, tier, owned, edit) => {
  sh(['stream', 'add', name, '--title', name, '--tier', tier, '--ship', 'on', ...LC]);
  viaHook(['owner', 'confirm', name, '--tier', tier, '--ship', 'on', ...LC]);
  write(`briefs/${name}.md`, brief2(owned), T);
  sh(['brief', 'record', name, '--file', path.join(T, `briefs/${name}.md`), ...LC]);
  const wt = path.join(WT, name); git(repo, 'branch', name, base2); addWorktree(wt, name);
  const d = J(sh(['dispatch', name, '--role', 'worker', '--dir', wt, '--prompt-file', PROMPT, ...LC]));
  edit(wt); const hd = commit(wt, name + ' round 1');
  waitRun(d.run_id); sh(['result', d.dispatch, ...LC]);
  const rv = J(sh(['dispatch', name, '--role', 'round_reviewer', ...LC]));
  write(`reviews/${name}.md`, 'verdict: MERGEABLE\n', T);
  sh(['result', rv.dispatch, '--outcome', 'done', '--file', path.join(T, `reviews/${name}.md`), ...LC]);
  const c = J(sh(['dispatch', name, '--role', 'ci', ...LC]));
  ci({ unit: 'pass', api: 'pass', golden: 'pass' }); runTests(c.dispatch, LC);
  return hd;
};
drive('t1', 'high', '- src/t.js', (wt) => write('src/t.js', 'ONE\ntwo\nthree\nfour\nfive\n', wt));
drive('t2', 'low', '- gen/**', (wt) => write('gen/out.txt', 'from t2\n', wt));
drive('t3', 'low', '- src/t.js', (wt) => write('src/t.js', 'one\ntwo\nthree\nfour\nFIVE\n', wt));
const wti2 = path.join(WT, 'int2'); git(repo, 'branch', 'cf/int2', base2); addWorktree(wti2, 'cf/int2');
merge(wti2, 't1');
r = sh(['merge', 'record', 't1', '--commit', git(wti2, 'rev-parse', 'HEAD'), ...LC]);
ok('(set-up) t1 merged', r.code === 0, r.out);
sh(['regenerate', ...LC]);
sh(['commit', 'record', '--kind', 'generated', '--commit', commit(wti2, 'regenerate'), ...LC]);
ok('(set-up) the planted generated-file conflict happens', !merge(wti2, 't2'));
write('gen/out.txt', 'generated v2\n', wti2);
const mT2 = commit(wti2, 'merge t2 (generated file: regenerated)');
r = sh(['merge', 'record', 't2', '--commit', mT2, ...LC]);
ok('Q-M5 a conflict only in generated paths does not make a low-tier stream red-team eligible', r.code === 0 && J(r)?.conflicts?.includes('gen/out.txt') && J(r)?.eligible?.length === 0, r.out);
const rtT1 = J(sh(['dispatch', 't1', '--role', 'stream_red_team', ...LC]));
write('reviews/t1-rt.md', 'verdict: CHANGES NEEDED\n\nF-M1 ONE is wrong\n', T);
sh(['result', rtT1.dispatch, '--outcome', 'done', '--file', path.join(T, 'reviews/t1-rt.md'), ...LC]);
r = sh(['status']);
ok('Q-M6 after a red team says CHANGES NEEDED the stream is shown as fixing', /\| t1 \|[^\n]*fixing/.test(r.out), r.out);
r = sh(['release-check']);
ok('Q-M6 release is refused while the red team\'s findings are open', r.code === 1 && /t1:[^"]*CHANGES NEEDED/.test(r.out), r.out);
const dF = J(sh(['dispatch', 't1', '--role', 'worker', '--on', 'integration', '--dir', wti2, '--prompt-file', PROMPT, ...LC]));
write('src/t.js', 'One\ntwo\nthree\nfour\nfive\n', wti2);
commit(wti2, 'fix F-M1 for t1');
waitRun(dF.run_id); sh(['result', dF.dispatch, ...LC]);
const rvFix = J(sh(['dispatch', 't1', '--role', 'round_reviewer', ...LC]));
write('reviews/t1-fix.md', 'verdict: MERGEABLE\n\nF-M1 closed\n', T);
sh(['result', rvFix.dispatch, '--outcome', 'done', '--file', path.join(T, 'reviews/t1-fix.md'), ...LC]);
sh(['regenerate', ...LC]);
const cI = J(sh(['dispatch', 'integration', '--role', 'ci', ...LC]));
ci({ unit: 'pass', api: 'pass', golden: 'pass' }); runTests(cI.dispatch, LC);
r = sh(['release-check']);
ok('Q-M6 a reviewed fix and a green combined test clear the stream, with no second red team', r.code === 0, r.out);
merge(wti2, 't3');
r = sh(['merge', 'record', 't3', '--commit', git(wti2, 'rev-parse', 'HEAD'), ...LC]);
ok('(set-up) t3, which touches t1\'s file, merges after t1\'s red team', r.code === 0, r.out);
r = sh(['release-check']);
ok('Q-M6 a later merge touching the stream\'s files makes its verdict stale', r.code === 1 && /t1:[^"]*stale/.test(r.out), r.out);
r = sh(['dispatch', 't1', '--role', 'stream_red_team', ...LC]);
ok('Q-M6 a stale stream is due a red team again, scoped to the later merge', r.code === 0 && /t3/.test(fs.readFileSync(J(r)?.pack || T, 'utf8').slice(0, 2000)), r.out);

// ---------- B-M5: the owner raises a budget inside the open run
r = viaHook(['owner', 'budget', 'max_red_team_passes', '2', '--why', 'hold it at what is used', ...LC]);
ok('B-M5 owner budget is recorded in the open run', r.code === 0 && J(r)?.after === 2, r.out);
r = sh(['dispatch', 't1', '--role', 'stream_red_team', ...LC]);
ok('B-M5 a used-up budget refuses, and names the command that raises it', r.code === 2 && /max_red_team_passes \(2\) is used up/.test(r.out) && /owner budget/.test(r.out), r.out);
r = sh(['owner', 'budget', 'max_red_team_passes', '9', '--why', 'more', ...LC]);
ok('B-M5 a budget raise is an owner record: refused without the hook\'s prompt', r.code === 2 && /prompt/.test(r.out), r.out);
viaHook(['owner', 'budget', 'max_red_team_passes', '9', '--why', 'the owner raises it', ...LC]);
r = sh(['dispatch', 't1', '--role', 'stream_red_team', ...LC]);
ok('B-M5 after the owner raises it in the open run, the dispatch is allowed', r.code === 0, r.out);
r = viaHook(['owner', 'budget', 'max_nothing', '9', '--why', 'x', ...LC]);
ok('B-M5 owner budget refuses a key that is not a budget', r.code === 2 && /budget/.test(r.out), r.out);

// ---------- B-M6: a stream named for a red team before its merge
const cfgPath = path.join(repo, 'change-factory.config.json');
const c3 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
c3.roles.pre_merge_red_team = { via: 'subagent', model: 'fable', fallback: ['opus'], on_fallback: 'owed_pass', streams: ['t5'] };
fs.writeFileSync(cfgPath, JSON.stringify(c3, null, 2));
r = viaHook(['trust', '--yes']);
ok('(set-up) the owner accepts a pre-merge red team for t5', r.code === 0, r.out);
drive('t4', 'low', '- src/t4.js', (wt) => { write('src/t4.js', 'export const t4 = 1;\n', wt); write('src/t4b.js', 'outside the lane\n', wt); });
const t5h = drive('t5', 'low', '- src/t5.js', (wt) => write('src/t5.js', 'export const t5 = 1;\n', wt));

// ---------- B-M1: a merge commit may hold only what git merged, plus the resolution of a real conflict
git(wti2, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'merge', '--no-ff', '--no-commit', 't4');
write('src/t4.js', 'export const t4 = 1;\nexport const backdoor = "never reviewed";\n', wti2);
write('src/evil.js', 'export const evil = true;\n', wti2);
const mEvil = commit(wti2, 'merge t4');
r = sh(['merge', 'record', 't4', '--commit', mEvil, ...LC]);
ok('B-M1 a merge commit that carries changes git did not make is refused, naming the files', r.code === 2 && /src\/evil\.js/.test(r.out) && /src\/t4\.js/.test(r.out), r.out);
git(wti2, 'reset', '-q', '--hard', 'HEAD~1');
merge(wti2, 't4');
r = sh(['merge', 'record', 't4', '--commit', git(wti2, 'rev-parse', 'HEAD'), ...LC]);
ok('B-M1 the same stream merged by git alone is recorded', r.code === 0, r.out);
ok('B-L8 merge record runs the lane check itself: outside its owned paths makes it eligible without a lane call', (J(r)?.eligible || []).includes('outside its lane'), r.out);

merge(wti2, 't5');
const mT5 = git(wti2, 'rev-parse', 'HEAD');
r = sh(['merge', 'record', 't5', '--commit', mT5, ...LC]);
ok('B-M6 a stream named for a pre-merge red team is not merged without its MERGEABLE verdict on that head', r.code === 2 && /pre_merge_red_team/.test(r.out), r.out);
r = sh(['dispatch', 't5', '--role', 'pre_merge_red_team', ...LC]);
const pm = J(r);
ok('B-M6 the pre-merge red team is dispatched on the stream head', r.code === 0 && pm?.target === t5h, r.out);
write('reviews/t5-pm.md', 'verdict: MERGEABLE\n', T);
sh(['result', pm.dispatch, '--outcome', 'done', '--file', path.join(T, 'reviews/t5-pm.md'), ...LC]);
r = sh(['merge', 'record', 't5', '--commit', mT5, ...LC]);
ok('B-M6 with that verdict the merge is recorded', r.code === 0, r.out);
const skill = (n) => fs.readFileSync(path.join(P, 'skills', n, 'SKILL.md'), 'utf8');
ok('B-M6 the run skill has the research stream steps', /dispatch <s> --role research/.test(skill('change-run')) && /research-analyst/.test(skill('change-run')));
ok('B-M6 intake creates the integration branch and its worktree from the run\'s base', /worktree add -b <integration branch>/.test(skill('change-intake')));
ok('B-M6 the run skill dispatches the pre-merge red team, and intake records the owner\'s choice', /dispatch <s> --role pre_merge_red_team/.test(skill('change-run')) && /pre_merge_red_team/.test(skill('change-intake')));

// ---------- B-M4: writes are serialised from the read to the append
const par = (args) => new Promise((res) => { const ch = spawn(process.execPath, [CF, ...args], { cwd: repo, env: ENV }); let o = ''; ch.stdout.on('data', (d) => { o += d; }); ch.stderr.on('data', (d) => { o += d; }); ch.on('exit', (code) => res({ code, out: o })); });
const outs = await Promise.all(Array.from({ length: 20 }, () => par(['dispatch', 't2', '--role', 'brief_writer', ...LC])));
const pids = outs.map((x) => { try { return JSON.parse(x.out).dispatch; } catch { return null; } });
ok('B-M4 twenty dispatches at once get twenty different ids', pids.every(Boolean) && new Set(pids).size === 20, JSON.stringify(pids) + outs.map((x) => x.out.slice(0, 100)).join(' | '));
const openT2 = (J(sh(['reconcile']))?.open_dispatches || []).filter((d) => d.stream === 't2' && d.role === 'brief_writer');
ok('B-M4 the log knows all twenty', openT2.length === 20, String(openT2.length));
ok('B-M4 the chain is intact after parallel writes', sh(['verify']).code === 0);

// ---------- B-L9: a test wait whose runner died ends
const deadPid = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
const deadState = path.join(T, 'dead-state.json');
fs.writeFileSync(deadState, JSON.stringify({ status: 'running', runner_pid: deadPid, log: path.join(T, 'dead.log') }));
let tw;
try { execFileSync(process.execPath, [CF, 'test', 'wait', '--state', deadState], { cwd: repo, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }); tw = { code: 0, out: '' }; }
catch (e) { tw = { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
ok('B-L9 test wait ends (exit 2) when the test runner is gone', tw.code === 2 && /gone/.test(tw.out), JSON.stringify(tw));

// ---------- B-L15, B-L16: config checks; the example's defaults
const r15 = path.join(T, 'r15'); fs.mkdirSync(r15); git(r15, 'init', '-q', '-b', 'main');
const noDocs = { ...cfg }; delete noDocs.docs_paths;
fs.writeFileSync(path.join(r15, 'change-factory.config.json'), JSON.stringify(noDocs));
r = sh(['trust'], { cwd: r15 });
ok('B-L15 a config without docs_paths is refused', r.code === 2 && /docs_paths/.test(r.out), r.out);
fs.writeFileSync(path.join(r15, 'change-factory.config.json'), JSON.stringify({ ...cfg, generated: { commands: [], paths: ['gen/**'] } }));
r = sh(['trust'], { cwd: r15 });
ok('B-L15 generated paths with no command that regenerates them are refused', r.code === 2 && /generated/.test(r.out), r.out);
fs.copyFileSync(path.join(P, 'examples', 'change-factory.config.json'), path.join(r15, 'change-factory.config.json'));
r = sh(['trust'], { cwd: r15 });
ok('B-L16 the example config passes the config checks and ships hook_mode deny', r.code === 0 && J(r)?.hook_mode === 'deny', r.out);

// ---------- B-L2: a broken chain stops every gate and write
const log2 = path.join(runs, proj, 'runs', 'r2', 'events.jsonl');
const l2 = fs.readFileSync(log2, 'utf8').split('\n');
const keep2 = l2[3];
l2[3] = l2[3].replace('"t1"', '"tX"');
fs.writeFileSync(log2, l2.join('\n'));
r = sh(['stream', 'add', 'zz', '--title', 'zz', '--tier', 'low', '--ship', 'on', ...LC]);
ok('B-L2 a write on a log whose chain is broken is refused', r.code === 2 && /verify/.test(r.out), r.out);
r = sh(['release-check']);
ok('B-L2 a gate on a log whose chain is broken is refused', r.code === 2 && /verify/.test(r.out), r.out);
l2[3] = keep2; fs.writeFileSync(log2, l2.join('\n'));
ok('(set-up) the log is whole again', sh(['verify']).code === 0);

for (const wt of fs.readdirSync(WT)) { try { git(repo, 'worktree', 'remove', '--force', path.join(WT, wt)); } catch {} }
fs.rmSync(T, { recursive: true, force: true });
fs.rmSync(elsewhere, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);

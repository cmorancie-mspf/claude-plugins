#!/usr/bin/env node
// oc-bridge core: start, answer, watch and stop non-interactive OpenCode runs.
// Each run is a detached process with a state file and a log, so it survives
// whatever started it. No dependencies.
//
//   node oc.mjs start  <run-id> --dir <folder> (--prompt-file <f> | --prompt <text>) --config <rules file>
//                      [--model <provider/model>] [--thinking] [--no-auto] [--no-rules] [--allow-project-config]
//   node oc.mjs answer <run-id> (--prompt-file <f> | --prompt <text>)
//   node oc.mjs status <run-id> [--tail <lines>]
//   node oc.mjs wait   <run-id> [--stall-min <minutes>]     exits when the run ends
//   node oc.mjs stop   <run-id>
//   node oc.mjs list
//
// An auto-approved run needs a rules file (--config). The rules are frozen when the run starts:
// a copy is kept with the run and every turn uses that copy.

import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HOME = process.env.OC_BRIDGE_HOME || path.join(os.homedir(), '.oc-bridge');
const RUNS = path.join(HOME, 'runs');
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MODEL_RE = /^[A-Za-z0-9][\w.-]*\/[\w@.:\/-]+(#[\w.-]+)?$/;
const WIN = process.platform === 'win32';

export class BridgeError extends Error {}

function findOpencode() {
  const named = process.env.OC_BRIDGE_OPENCODE;
  if (named) {
    if (!fs.existsSync(named)) throw new BridgeError(`OC_BRIDGE_OPENCODE names a file that does not exist: ${named}`);
    if (WIN && /\.(cmd|bat|ps1)$/i.test(named)) {
      throw new BridgeError(`OC_BRIDGE_OPENCODE must name the opencode binary, not the ${path.extname(named)} shim. ` +
        'The binary is under node_modules\\@opencode\\cli\\bin\\opencode.exe beside the shim.');
    }
    return named;
  }
  const exe = WIN ? 'opencode.exe' : 'opencode';
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    // npm puts a .cmd shim on PATH; the real binary sits under node_modules beside it.
    for (const c of [path.join(d, 'node_modules', '@opencode', 'cli', 'bin', exe), path.join(d, exe)]) {
      if (fs.existsSync(c)) return c;
    }
  }
  throw new BridgeError('opencode binary not found; set OC_BRIDGE_OPENCODE to its full path');
}

const runDir = (id) => path.join(RUNS, id);
const statePath = (id) => path.join(runDir(id), 'state.json');
const logPath = (id) => path.join(runDir(id), 'log.txt');
const rulesPath = (id) => path.join(runDir(id), 'rules.json');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function checkId(id) {
  if (!id || !ID_RE.test(id)) throw new BridgeError(`bad run id "${id}": letters, digits, _ and -, at most 64`);
}

function readState(id) {
  checkId(id);
  let s;
  try { s = JSON.parse(fs.readFileSync(statePath(id), 'utf8')); }
  catch { throw new BridgeError(`no run "${id}"`); }
  if (!s || typeof s !== 'object' || !Array.isArray(s.turns) || !s.turns.length) throw new BridgeError(`the record of run "${id}" is damaged`);
  return s;
}

function writeState(id, state) {
  const tmp = statePath(id) + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath(id));
}

function pidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// The full command line of a live process, or null when it cannot be read.
function commandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (WIN) {
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 20000 }).trim();
      return out || null;
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || null;
  } catch { return null; }
}

// Is a recorded process still this run's? A pid is reused after a reboot or a crash, so a
// stale record can name an unrelated process.
//  - A turn that began before this machine last booted cannot have a live process.
//  - For reporting, a live pid is then enough.
//  - Before killing (`strong`), the process's own command line must name this run: the
//    OpenCode process carries the run's session id, and the runner carries `_run <id>`.
function liveness(s, strong = false) {
  const turn = s.turns[s.turns.length - 1];
  const bootedAt = Date.now() - os.uptime() * 1000;
  if (!turn.started_at || Date.parse(turn.started_at) < bootedAt - 5000) return { child: false, runner: false };
  let child = pidExists(s.pid), runner = pidExists(s.runner_pid);
  if (strong) {
    const c = child ? commandLine(s.pid) : null;
    const r = runner ? commandLine(s.runner_pid) : null;
    child = !!c && c.includes(s.session);
    runner = !!r && r.includes('_run') && r.includes(s.id);
  }
  return { child, runner };
}

function promptToFile(id, turn, { prompt, promptFile }) {
  if (promptFile) {
    const abs = path.resolve(promptFile);
    if (!fs.existsSync(abs)) throw new BridgeError(`prompt file not found: ${abs}`);
    return abs;
  }
  if (!prompt || !prompt.trim()) throw new BridgeError('give a prompt or a prompt file');
  const p = path.join(runDir(id), `turn-${turn}.md`);
  fs.writeFileSync(p, prompt);
  return p;
}

function launch(id) {
  const child = spawn(process.execPath, [SELF, '_run', id], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

function readRules(config) {
  const abs = path.resolve(config);
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { throw new BridgeError(`rules file not found: ${abs}`); }
  let j;
  try { j = JSON.parse(text); if (!j || typeof j !== 'object' || Array.isArray(j)) throw 0; }
  catch { throw new BridgeError(`rules file is not a JSON object: ${abs}`); }
  const extras = Object.keys(j).filter((k) => k !== '$schema' && k !== 'permission');
  if (extras.length) throw new BridgeError(`the rules file holds more than rules (${extras.join(', ')}): ${abs}. A rules file may hold "$schema" and "permission" only; anything else is something OpenCode would load or run.`);
  const bash = j.permission?.bash;
  if (bash && typeof bash === 'object') {
    // Which rule wins when two match depends on their order. Only one shape is accepted:
    // an optional first "*": "allow", then denies and nothing else.
    const odd = Object.entries(bash).filter(([k, v], i) => v !== 'deny' && !(i === 0 && k === '*' && v === 'allow')).map(([k]) => k);
    if (odd.length) throw new BridgeError(`the rules file has shell rules that are not denies (${odd.slice(0, 5).join(', ')}): ${abs}. Only a first "*": "allow" may allow; a later or narrower allow could switch a deny off.`);
  }
  const refuses = bash === 'deny' || (bash && typeof bash === 'object' && Object.values(bash).includes('deny'));
  if (!refuses) throw new BridgeError(`the rules file refuses no shell command (${abs}). A rules file that allows everything is no rules: say no_rules explicitly if that is what is wanted.`);
  return { abs, text };
}

// Folders from the run folder up to the top of its git checkout: where OpenCode looks for a
// project's own config.
function projectConfigs(dir) {
  const names = ['opencode.json', 'opencode.jsonc', '.opencode'];
  const at = (d) => names.map((n) => path.join(d, n)).filter((p) => fs.existsSync(p));
  const home = path.resolve(os.homedir());
  const chain = [];
  let d = path.resolve(dir), top = false;
  for (;;) {
    chain.push(d);
    if (fs.existsSync(path.join(d, '.git'))) { top = true; break; }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  // Outside a git checkout only the run folder itself is the project. The user's home folder
  // holds OpenCode's own global settings, which are not a project config.
  const folders = (top ? chain : [chain[0]]).filter((x) => x.toLowerCase() !== home.toLowerCase());
  return folders.flatMap(at);
}

// The rules as OpenCode is given them: at the top level and again for each built-in agent,
// because an agent's own permission block outranks the top-level one.
function effectiveRules(text) {
  const rules = JSON.parse(text);
  const agent = { ...(rules.agent || {}) };
  for (const a of ['build', 'plan', 'general', 'explore']) agent[a] = { ...(agent[a] || {}), permission: rules.permission };
  return JSON.stringify({ ...rules, default_agent: 'build', agent });
}

export function start({ id, dir, prompt, promptFile, model, auto = true, config, thinking = false, noRules = false, allowProjectConfig = false }) {
  checkId(id);
  if (fs.existsSync(statePath(id))) throw new BridgeError(`run "${id}" exists; use answer to continue it, or pick a new id`);
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new BridgeError(`folder not found: ${dir}`);
  if (model && !MODEL_RE.test(model)) throw new BridgeError(`bad model "${model}": give provider/model, as \`opencode models\` prints it`);
  // Fail closed. Auto-approval with nothing refused is never the default.
  if (auto && !config && !noRules) {
    throw new BridgeError('an auto-approved run needs a rules file: pass config (a file of deny rules). ' +
      'To run auto-approved with nothing refused, say so explicitly with no_rules (--no-rules).');
  }
  const rules = config ? readRules(config) : null;
  const own = projectConfigs(dir);
  if (rules && own.length && !allowProjectConfig) {
    throw new BridgeError(`this folder has its own OpenCode config (${own.join(', ')}). A project config can define agents and permissions that override the rules. Remove it, or pass allow_project_config (--allow-project-config) after reading it.`);
  }
  const opencode = findOpencode();
  fs.mkdirSync(runDir(id), { recursive: true });
  if (rules) fs.writeFileSync(rulesPath(id), rules.text);
  const file = promptToFile(id, 1, { prompt, promptFile });
  writeState(id, {
    id, dir: path.resolve(dir), model: model || null, auto: !!auto, opencode,
    config: rules ? rules.abs : null, rules_sha256: rules ? sha(rules.text) : null, thinking: !!thinking,
    allow_project_config: !!allowProjectConfig,
    session: 'ses_' + id.replace(/[^A-Za-z0-9]/g, '') + Date.now().toString(36),
    status: 'starting', turn: 1, turns: [{ turn: 1, prompt_file: file, started_at: new Date().toISOString() }],
    pid: null, runner_pid: null, exit_code: null,
  });
  fs.writeFileSync(logPath(id), '');
  launch(id);
  return status({ id, tail: 0 });
}

export function answer({ id, prompt, promptFile }) {
  const s = readState(id);
  if (s.status === 'running' || s.status === 'starting') {
    const live = liveness(s);
    const age = Date.now() - Date.parse(s.turns[s.turns.length - 1].started_at);
    // A turn that has just been launched has no pid recorded yet; it is still running.
    if (live.child || live.runner || (s.status === 'starting' && age < 20_000)) {
      throw new BridgeError(`run "${id}" is still running; wait for it to end, or stop it`);
    }
  }
  if (s.rules_sha256) {
    let kept = null;
    try { kept = fs.readFileSync(rulesPath(id), 'utf8'); } catch { /* reported below */ }
    if (kept === null || sha(kept) !== s.rules_sha256) {
      throw new BridgeError(`the rules kept with run "${id}" are missing or have been changed since it started. ` +
        'Something edited them between turns. Do not continue this run; start a new one after finding out what did.');
    }
  }
  const turn = s.turn + 1;
  const file = promptToFile(id, turn, { prompt, promptFile });
  s.turn = turn;
  s.turns.push({ turn, prompt_file: file, started_at: new Date().toISOString() });
  s.status = 'starting'; s.pid = null; s.runner_pid = null; s.exit_code = null; delete s.ended_at;
  writeState(id, s);
  launch(id);
  return status({ id, tail: 0 });
}

function tailOf(file, lines) {
  lines = Math.max(0, Math.floor(Number(lines) || 0));
  if (!lines) return '';
  let text;
  try {
    const size = fs.statSync(file).size;
    const want = Math.min(size, 200_000);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, size - want);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return ''; }
  // strip terminal colour codes
  text = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  return text.split(/\r?\n/).slice(-lines).join('\n');
}

export function status({ id, tail = 30 }) {
  const s = readState(id);
  let st = s.status;
  if (st === 'running' || st === 'starting') {
    const live = liveness(s);
    if (!live.child && !live.runner) {
      // give a just-launched runner a moment to record its pid
      const last = s.turns[s.turns.length - 1];
      if (st === 'running' || Date.now() - Date.parse(last.started_at) > 20_000) st = 'died';
    }
  }
  let quiet = null, logBytes = 0;
  try { const f = fs.statSync(logPath(id)); quiet = Math.round((Date.now() - f.mtimeMs) / 1000); logBytes = f.size; } catch {}
  let rulesChanged = null;
  if (s.config && s.rules_sha256) {
    try { rulesChanged = sha(fs.readFileSync(s.config, 'utf8')) !== s.rules_sha256; } catch { rulesChanged = true; }
  }
  return {
    id, status: st, exit_code: s.exit_code, turn: s.turn, dir: s.dir, model: s.model,
    config: s.config || null, rules: s.rules_sha256 ? 'frozen at start' : (s.auto ? 'NONE: auto-approved with nothing refused' : 'none'),
    rules_file_changed_since_start: rulesChanged,
    thinking: !!s.thinking, session: s.session,
    pid: s.pid, started_at: s.turns[s.turns.length - 1].started_at, ended_at: s.ended_at || null,
    seconds_since_output: st === 'running' ? quiet : null, log_bytes: logBytes, log: logPath(id),
    tail: tailOf(logPath(id), tail),
  };
}

export function stop({ id }) {
  const s = readState(id);
  const live = liveness(s, true);
  // Record the stop first, so the runner's exit handler does not overwrite it with "failed".
  if (s.status === 'running' || s.status === 'starting') {
    s.status = 'stopped'; s.ended_at = new Date().toISOString();
    writeState(id, s);
  }
  const kill = (pid, group) => {
    try {
      if (WIN) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else process.kill(group ? -pid : pid, 'SIGTERM');
    } catch {}
  };
  // Only a process this bridge can show to be its own is killed.
  if (live.child) kill(s.pid, true);
  if (live.runner) kill(s.runner_pid, false);
  const out = status({ id, tail: 10 });
  out.killed = { opencode: live.child, runner: live.runner };
  if (!live.child && !live.runner) out.note = 'no process of this run was found running; nothing was killed';
  return out;
}

export function list() {
  let ids = [];
  try { ids = fs.readdirSync(RUNS); } catch {}
  const rows = [];
  for (const i of ids) {
    if (!fs.existsSync(statePath(i))) continue;
    try {
      const s = status({ id: i, tail: 0 });
      rows.push({ id: s.id, status: s.status, exit_code: s.exit_code, turn: s.turn, dir: s.dir, started_at: s.started_at });
    } catch (e) {
      rows.push({ id: i, status: 'unreadable', note: e.message });
    }
  }
  return rows.sort((a, b) => ((a.started_at || '') < (b.started_at || '') ? 1 : -1));
}

// The detached runner: owns the opencode process for one turn and records how it ended.
function runTurn(id) {
  const s = readState(id);
  const turn = s.turns[s.turns.length - 1];
  const out = fs.openSync(logPath(id), 'a');
  fs.writeSync(out, `\n===== oc-bridge turn ${s.turn} · ${turn.started_at} · ${turn.prompt_file} =====\n`);
  const finish = (code, note) => {
    const e = readState(id);
    if (note) fs.writeSync(out, `\n[oc-bridge] ${note}\n`);
    if (e.status === 'stopped') {
      fs.writeSync(out, `\n===== oc-bridge turn ${e.turn} stopped · ${new Date().toISOString()} =====\n`);
      return process.exit(0);
    }
    e.status = code === 0 ? 'finished' : 'failed';
    e.exit_code = code; e.ended_at = new Date().toISOString();
    e.turns[e.turns.length - 1].ended_at = e.ended_at;
    e.turns[e.turns.length - 1].exit_code = code;
    fs.writeSync(out, `\n===== oc-bridge turn ${e.turn} ended · exit ${code} · ${e.ended_at} =====\n`);
    writeState(id, e);
    process.exit(0);
  };

  // OpenCode takes its working folder from PWD when a POSIX shell has set it, not from the
  // process's real folder; an inherited PWD sends the run to the caller's folder.
  const env = { ...process.env, PWD: s.dir };
  delete env.OLDPWD; delete env.INIT_CWD;
  delete env.OPENCODE_CONFIG; delete env.OPENCODE_CONFIG_CONTENT;

  const message = `Your instructions for this turn are in the file ${turn.prompt_file} . Read that whole file now and follow it exactly.`;
  const args = ['run', '--session', s.session];
  if (s.model) args.push('--model', s.model);
  if (s.auto) args.push('--auto');
  if (s.thinking) args.push('--thinking');
  if (s.rules_sha256) {
    // The rules are the copy frozen at start, checked against the hash recorded then.
    let text = null;
    try { text = fs.readFileSync(rulesPath(id), 'utf8'); } catch { /* handled below */ }
    if (text === null || sha(text) !== s.rules_sha256) return finish(-1, 'the rules kept with this run are missing or changed; the turn was not started');
    // Checked at every turn: a config file written during the last turn would take effect in this one.
    const own = projectConfigs(s.dir);
    if (own.length && !s.allow_project_config) return finish(-1, 'the run folder now has its own OpenCode config (' + own.join(', ') + '), which can override the rules; the turn was not started. Something created it: find out what before continuing.');
    // A project's own opencode.json outranks OPENCODE_CONFIG and could switch the rules off.
    // OPENCODE_CONFIG_CONTENT outranks the project file. It reaches OpenCode only through a
    // private server: the shared background service does not see this process's environment.
    env.OPENCODE_CONFIG_CONTENT = effectiveRules(text);
    args.push('--standalone');
  } else if (s.auto) {
    fs.writeSync(out, '[oc-bridge] WARNING: this run is auto-approved with no rules file. Nothing is refused.\n');
  }
  args.push(message);

  let child;
  try {
    // Off Windows the child leads its own process group, so stop can end what it started.
    child = spawn(s.opencode, args, { cwd: s.dir, env, stdio: ['ignore', out, out], windowsHide: true, detached: !WIN });
  } catch (err) {
    return finish(-1, 'could not start opencode (' + s.opencode + '): ' + err.message);
  }
  s.status = 'running'; s.pid = child.pid ?? null; s.runner_pid = process.pid;
  writeState(id, s);
  child.on('error', (err) => finish(-1, 'could not start opencode (' + s.opencode + '): ' + err.message));
  child.on('exit', (code, signal) => finish(code ?? -1, signal ? 'ended by signal ' + signal : null));
}

async function waitFor({ id, stallMin = 0 }) {
  for (;;) {
    const s = status({ id, tail: 0 });
    if (s.status !== 'running' && s.status !== 'starting') return { ...status({ id, tail: 40 }), stalled: false };
    if (stallMin && s.seconds_since_output !== null && s.seconds_since_output > stallMin * 60) {
      return { ...status({ id, tail: 40 }), stalled: true };
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-auto') o.auto = false;
    else if (a === '--thinking') o.thinking = true;
    else if (a === '--no-rules') o.noRules = true;
    else if (a === '--allow-project-config') o.allowProjectConfig = true;
    else if (a.startsWith('--')) o[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    else o._.push(a);
  }
  return o;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = parseArgs(rest);
  const id = o._[0];
  const print = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  switch (cmd) {
    case '_run': return runTurn(id);
    case 'start': return print(start({ id, dir: o.dir, prompt: o.prompt, promptFile: o.promptFile, model: o.model, auto: o.auto !== false, config: o.config, thinking: !!o.thinking, noRules: !!o.noRules, allowProjectConfig: !!o.allowProjectConfig }));
    case 'answer': return print(answer({ id, prompt: o.prompt, promptFile: o.promptFile }));
    case 'status': return print(status({ id, tail: o.tail ? Number(o.tail) : 30 }));
    case 'stop': return print(stop({ id }));
    case 'list': return print(list());
    case 'wait': {
      const r = await waitFor({ id, stallMin: o.stallMin ? Number(o.stallMin) : 0 });
      const { tail, ...head } = r;
      print(head); console.log('----- last output -----\n' + tail);
      process.exit(r.stalled ? 3 : r.status === 'finished' ? 0 : 1);
    }
    default:
      print('usage: oc.mjs start|answer|status|wait|stop|list  (see the header of this file)');
      process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main().catch((e) => { console.error(e instanceof BridgeError ? 'oc-bridge: ' + e.message : e); process.exit(2); });
}

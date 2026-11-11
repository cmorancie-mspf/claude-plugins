#!/usr/bin/env node
// oc-bridge core: start, answer, watch and stop non-interactive OpenCode runs.
// Each run is a detached process with a state file and a log, so it survives
// whatever started it. No dependencies.
//
//   node oc.mjs start  <run-id> --dir <folder> (--prompt-file <f> | --prompt <text>) [--model <provider/model>] [--config <opencode config file>] [--thinking] [--no-auto]
//   node oc.mjs answer <run-id> (--prompt-file <f> | --prompt <text>)
//   node oc.mjs status <run-id> [--tail <lines>]
//   node oc.mjs wait   <run-id> [--stall-min <minutes>]     exits when the run ends
//   node oc.mjs stop   <run-id>
//   node oc.mjs list

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HOME = process.env.OC_BRIDGE_HOME || path.join(os.homedir(), '.oc-bridge');
const RUNS = path.join(HOME, 'runs');
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class BridgeError extends Error {}

function findOpencode() {
  if (process.env.OC_BRIDGE_OPENCODE) return process.env.OC_BRIDGE_OPENCODE;
  const exe = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
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

function checkId(id) {
  if (!id || !ID_RE.test(id)) throw new BridgeError(`bad run id "${id}": letters, digits, _ and -, at most 64`);
}

function readState(id) {
  checkId(id);
  try { return JSON.parse(fs.readFileSync(statePath(id), 'utf8')); }
  catch { throw new BridgeError(`no run "${id}"`); }
}

function writeState(id, state) {
  const tmp = statePath(id) + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath(id));
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
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

export function start({ id, dir, prompt, promptFile, model, auto = true, config, thinking = false }) {
  checkId(id);
  if (fs.existsSync(statePath(id))) throw new BridgeError(`run "${id}" exists; use answer to continue it, or pick a new id`);
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new BridgeError(`folder not found: ${dir}`);
  const opencode = findOpencode();
  if (config && !fs.existsSync(config)) throw new BridgeError(`config file not found: ${config}`);
  fs.mkdirSync(runDir(id), { recursive: true });
  const file = promptToFile(id, 1, { prompt, promptFile });
  writeState(id, {
    id, dir: path.resolve(dir), model: model || null, auto: !!auto, opencode, config: config ? path.resolve(config) : null, thinking: !!thinking,
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
    if (alive(s.runner_pid) || alive(s.pid)) throw new BridgeError(`run "${id}" is still running; wait for it to end, or stop it`);
  }
  const turn = s.turn + 1;
  const file = promptToFile(id, turn, { prompt, promptFile });
  s.turn = turn;
  s.turns.push({ turn, prompt_file: file, started_at: new Date().toISOString() });
  s.status = 'starting'; s.pid = null; s.runner_pid = null; s.exit_code = null;
  writeState(id, s);
  launch(id);
  return status({ id, tail: 0 });
}

function tailOf(file, lines) {
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
  if ((st === 'running' || st === 'starting') && !alive(s.runner_pid) && !alive(s.pid)) {
    // give a just-launched runner a moment to record its pid
    const last = s.turns[s.turns.length - 1];
    if (st === 'running' || Date.now() - Date.parse(last.started_at) > 15_000) st = 'died';
  }
  let quiet = null, logBytes = 0;
  try { const f = fs.statSync(logPath(id)); quiet = Math.round((Date.now() - f.mtimeMs) / 1000); logBytes = f.size; } catch {}
  return {
    id, status: st, exit_code: s.exit_code, turn: s.turn, dir: s.dir, model: s.model, config: s.config || null, session: s.session,
    pid: s.pid, started_at: s.turns[s.turns.length - 1].started_at, ended_at: s.ended_at || null,
    seconds_since_output: st === 'running' ? quiet : null, log_bytes: logBytes, log: logPath(id),
    tail: tailOf(logPath(id), tail),
  };
}

export function stop({ id }) {
  const s = readState(id);
  for (const pid of [s.pid, s.runner_pid]) {
    if (!alive(pid)) continue;
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(pid, 'SIGTERM');
    } catch {}
  }
  const now = readState(id);
  if (now.status === 'running' || now.status === 'starting') {
    now.status = 'stopped'; now.ended_at = new Date().toISOString();
    writeState(id, now);
  }
  return status({ id, tail: 10 });
}

export function list() {
  let ids = [];
  try { ids = fs.readdirSync(RUNS); } catch {}
  return ids.filter((i) => fs.existsSync(statePath(i))).map((i) => {
    const s = status({ id: i, tail: 0 });
    return { id: s.id, status: s.status, exit_code: s.exit_code, turn: s.turn, dir: s.dir, started_at: s.started_at };
  }).sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
}

// The detached runner: owns the opencode process for one turn and records how it ended.
function runTurn(id) {
  const s = readState(id);
  const turn = s.turns[s.turns.length - 1];
  const out = fs.openSync(logPath(id), 'a');
  fs.writeSync(out, `\n===== oc-bridge turn ${s.turn} · ${turn.started_at} · ${turn.prompt_file} =====\n`);
  const message = `Your instructions for this turn are in the file ${turn.prompt_file} . Read that whole file now and follow it exactly.`;
  const args = ['run', '--session', s.session];
  if (s.model) args.push('--model', s.model);
  if (s.auto) args.push('--auto');
  if (s.thinking) args.push('--thinking');
  // A config file reaches OpenCode only through a private server: the shared background
  // service does not see this process's environment (and a run given one hangs).
  if (s.config) args.push('--standalone');
  args.push(message);
  // OpenCode takes its working folder from PWD when a POSIX shell has set it, not from the
  // process's real folder; an inherited PWD sends the run to the caller's folder.
  const env = { ...process.env, PWD: s.dir };
  delete env.OLDPWD; delete env.INIT_CWD;
  if (s.config) env.OPENCODE_CONFIG = s.config;
  const child = spawn(s.opencode, args, { cwd: s.dir, env, stdio: ['ignore', out, out], windowsHide: true });
  s.status = 'running'; s.pid = child.pid; s.runner_pid = process.pid;
  writeState(id, s);
  const finish = (code, note) => {
    const e = readState(id);
    if (e.status === 'stopped') return process.exit(0);
    e.status = code === 0 ? 'finished' : 'failed';
    e.exit_code = code; e.ended_at = new Date().toISOString();
    e.turns[e.turns.length - 1].ended_at = e.ended_at;
    e.turns[e.turns.length - 1].exit_code = code;
    if (note) fs.writeSync(out, `\n[oc-bridge] ${note}\n`);
    fs.writeSync(out, `\n===== oc-bridge turn ${e.turn} ended · exit ${code} · ${e.ended_at} =====\n`);
    writeState(id, e);
    process.exit(0);
  };
  child.on('error', (err) => finish(-1, 'could not start opencode: ' + err.message));
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
    case 'start': return print(start({ id, dir: o.dir, prompt: o.prompt, promptFile: o.promptFile, model: o.model, auto: o.auto !== false, config: o.config, thinking: !!o.thinking }));
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

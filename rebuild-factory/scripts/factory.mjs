#!/usr/bin/env node
// rebuild-factory helper: the deterministic parts of the loop. No dependencies.
//
//   node factory.mjs init [--repo <path>] [--plan <dir>] [--project <name>] [--commit-plan]
//   node factory.mjs where [--plan <dir>]
//   node factory.mjs prompt <session> --notes-file <file> [--plan <dir>]
//   node factory.mjs check-handback <session> [--plan <dir>]
//   node factory.mjs show                     every setting, its value and its meaning
//   node factory.mjs set <key> <value>        for example: set builder.model provider/model
//   node factory.mjs add|remove <key> <item>  for the list settings
//
// Without --plan, the plan folder is the nearest factory-plan/ at or above the current folder.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAN_NAME = 'factory-plan';
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const HANDBACK_HEADINGS = [
  'Identity', 'Summary', 'Phase command', 'Acceptance tests', 'Requirements', 'Mutations', 'Opt-outs',
  'Changes to earlier tests, fixtures or harness', 'Spikes', 'Deviations from the plan', 'Not done',
  'Needs the owner', 'Files', 'Least sure of',
];

class Fail extends Error {}
const fail = (m) => { throw new Fail(m); };

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit-plan') o.commitPlan = true;
    else if (a.startsWith('--')) o[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    else o._.push(a);
  }
  return o;
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function findPlan(o) {
  if (o.plan) {
    const p = path.resolve(o.plan);
    if (!fs.existsSync(path.join(p, 'factory.config.json'))) fail(`no factory.config.json in ${p}`);
    return p;
  }
  let d = process.cwd();
  for (;;) {
    const p = path.basename(d) === PLAN_NAME ? d : path.join(d, PLAN_NAME);
    if (fs.existsSync(path.join(p, 'factory.config.json'))) return p;
    const up = path.dirname(d);
    if (up === d) fail(`no ${PLAN_NAME}/factory.config.json at or above ${process.cwd()}; run init, or pass --plan`);
    d = up;
  }
}

function load(o) {
  const plan = findPlan(o);
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(path.join(plan, 'factory.config.json'), 'utf8')); }
  catch (e) { fail('factory.config.json is not valid JSON: ' + e.message); }
  for (const k of ['project', 'repo', 'worktree_root']) if (!cfg[k]) fail(`factory.config.json: "${k}" is empty`);
  let sessions = [];
  const pj = path.join(plan, 'plan', 'phases.json');
  if (fs.existsSync(pj)) {
    try { sessions = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch (e) { fail('plan/phases.json is not valid JSON: ' + e.message); }
    if (!Array.isArray(sessions)) fail('plan/phases.json must be an array of sessions');
    const seen = new Set();
    for (const s of sessions) {
      if (!s || !SESSION_RE.test(s.id || '')) fail(`plan/phases.json: bad session id ${JSON.stringify(s && s.id)}`);
      if (seen.has(s.id)) fail(`plan/phases.json: session ${s.id} is listed twice`);
      seen.add(s.id);
    }
  }
  return { plan, cfg, sessions };
}

// The block of one session in phases.md: from its heading to the next session heading.
function sessionBlock(plan, id) {
  const f = path.join(plan, 'plan', 'phases.md');
  if (!fs.existsSync(f)) return null;
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^#{2,4} Session ${esc}(\\s*[:—-]|\\s*$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^#{2,4} Session \S/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start, end);
}

function readLine(plan, id) {
  const block = sessionBlock(plan, id);
  if (!block) return { block: false, filled: false };
  const line = block.find((l) => /^\**Read\**\s*[:|]/i.test(l.replace(/^[|\s]+/, '')));
  if (!line) return { block: true, filled: false };
  const text = line.replace(/^[|\s]*\**Read\**\s*[:|]\s*/i, '').replace(/\|\s*$/, '').trim();
  return { block: true, filled: text.length > 10 && !/to be filled|tbd|todo/i.test(text) };
}

function tags(cfg) {
  try { return new Set(git(cfg.repo, ['tag', '-l', cfg.tag_prefix + '*']).split(/\r?\n/).filter(Boolean)); }
  catch { fail(`cannot read git tags in ${cfg.repo}`); }
}

function bridgeRun(cfg, id) {
  const home = process.env.OC_BRIDGE_HOME || path.join(os.homedir(), '.oc-bridge');
  const run = `${cfg.project}-${id}`.replace(/[^A-Za-z0-9_-]/g, '-');
  try {
    const s = JSON.parse(fs.readFileSync(path.join(home, 'runs', run, 'state.json'), 'utf8'));
    return { run, recorded_status: s.status, turn: s.turn };
  } catch { return { run, recorded_status: null, turn: 0 }; }
}

function handbackState(plan, id) {
  const f = path.join(plan, 'handback', id, 'handback.md');
  if (!fs.existsSync(f)) return { present: false };
  const text = fs.readFileSync(f, 'utf8');
  const lines = text.split(/\r?\n/);
  let at = -1;
  const missing = [];
  HANDBACK_HEADINGS.forEach((h, n) => {
    const re = new RegExp(`^#{1,4}\\s*${n}[.):]?\\s+${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
    const i = lines.findIndex((l, k) => k > at && re.test(l.trim()));
    if (i < 0) missing.push(`${n}. ${h}`); else at = i;
  });
  const nd = lines.findIndex((l) => /^#{1,4}\s*10[.):]?\s+Not done/i.test(l.trim()));
  let blocked = false;
  if (nd >= 0) {
    for (let i = nd + 1; i < lines.length && !/^#{1,4}\s/.test(lines[i]); i++) {
      if (lines[i].trim()) { blocked = /^[*_`\s-]*blocked\b/i.test(lines[i]); break; }
    }
  }
  return { present: true, file: f, headings_ok: missing.length === 0, missing, blocked };
}

function sessionState({ plan, cfg, sessions }, s, tagSet) {
  const wt = path.join(cfg.worktree_root, s.id);
  const hb = handbackState(plan, s.id);
  const st = {
    id: s.id, title: s.title || '', kind: s.kind || 'build', paid: !!s.paid, gate: s.gate || null,
    accepted: tagSet.has(cfg.tag_prefix + s.id),
    read_line: readLine(plan, s.id),
    prompt: fs.existsSync(path.join(plan, 'handback', `${s.id}-PROMPT.md`)),
    worktree: fs.existsSync(wt) ? wt : null,
    run: bridgeRun(cfg, s.id),
    handback: hb,
    review: fs.existsSync(path.join(plan, 'handback', s.id, 'REVIEW.md')),
  };
  st.stage = st.accepted ? 'accepted'
    : st.review && hb.present ? 'reviewed, not accepted: findings are with the builder, or the merge is pending'
    : hb.present && hb.blocked ? 'blocked: the builder has a question'
    : hb.present ? 'handed back: review it'
    : st.run.recorded_status ? `run ${st.run.recorded_status} (turn ${st.run.turn}): check its status`
    : st.worktree && st.prompt ? 'ready to start the builder'
    : st.prompt ? 'prompt written: create the worktree'
    : st.read_line.filled ? 'read line filled: write the prompt'
    : st.read_line.block ? 'not ready: fill the Read line'
    : 'not ready: no session block in plan/phases.md';
  return st;
}

function cmdWhere(o) {
  const ctx = load(o);
  const { cfg, sessions, plan } = ctx;
  if (!sessions.length) return { plan, project: cfg.project, sessions: 0, next: null, note: 'plan/phases.json lists no sessions yet: the plan stage has not produced the session map' };
  const tagSet = tags(cfg);
  const accepted = sessions.filter((s) => tagSet.has(cfg.tag_prefix + s.id)).map((s) => s.id);
  const first = sessions.find((s) => !tagSet.has(cfg.tag_prefix + s.id));
  const outOfOrder = first ? sessions.slice(sessions.indexOf(first)).filter((s) => tagSet.has(cfg.tag_prefix + s.id)).map((s) => s.id) : [];
  const out = { plan, project: cfg.project, sessions: sessions.length, accepted: accepted.length, remaining: sessions.length - accepted.length, next: first ? sessionState(ctx, first, tagSet) : null };
  if (outOfOrder.length) out.warning = `accepted out of order, after the next session: ${outOfOrder.join(', ')}`;
  if (first && (first.paid || first.gate)) out.stop_for_owner = first.paid ? 'this session has a paid or live test: say what it will spend and wait' : `gate: ${first.gate}`;
  if (!first) out.note = 'every session is accepted';
  return out;
}

function cmdPrompt(o) {
  const ctx = load(o);
  const { cfg, sessions, plan } = ctx;
  const id = o._[0];
  const s = sessions.find((x) => x.id === id) || fail(`session "${id}" is not in plan/phases.json`);
  const rl = readLine(plan, id);
  if (!rl.block) fail(`no block "### Session ${id}" in plan/phases.md`);
  if (!rl.filled) fail(`session ${id} is not ready: its Read line is not filled`);
  if (!o.notesFile) fail('pass --notes-file: the notes for this session (what the last review found, what to watch for). A file that says "None." is allowed for a first session.');
  const notes = fs.readFileSync(path.resolve(o.notesFile), 'utf8').trim() || fail('the notes file is empty');
  const own = path.join(plan, 'prompts', 'KICKOFF.md');
  let t = fs.readFileSync(fs.existsSync(own) ? own : path.join(ROOT, 'templates', 'kickoff-prompt.md'), 'utf8');
  const tagSet = tags(cfg);
  const before = sessions.slice(0, sessions.indexOf(s)).filter((x) => tagSet.has(cfg.tag_prefix + x.id));
  const cmd = (c) => (c || '').replaceAll('{session}', id);
  const para = path.join(plan, 'prompts', 'PROJECT.md');
  const values = {
    SESSION: id, PROJECT: cfg.project, WORKTREE: path.join(cfg.worktree_root, id), BRANCH: cfg.branch_prefix + id,
    PLAN_DIR: plan, PREVIOUS_TAG: before.length ? cfg.tag_prefix + before[before.length - 1].id : cfg.tag_prefix + 'baseline',
    PHASE_COMMAND: cmd(cfg.commands?.phase), MUTATE_COMMAND: cmd(cfg.commands?.mutate),
    OWNER_ONLY: (cfg.owner_only || []).join('; '),
    MUST_NOT_READ: (cfg.builder_must_not_read || []).map((p) => '`' + p + '`').join(', '),
    PROJECT_PARAGRAPH: fs.existsSync(para) ? fs.readFileSync(para, 'utf8').trim() : '',
    SPIKE_BLOCK: s.kind === 'spike' ? fs.readFileSync(path.join(ROOT, 'templates', 'spike-block.md'), 'utf8') : '',
    NOTES: notes,
  };
  const empty = Object.entries(values).filter(([k, v]) => !v && !['SPIKE_BLOCK'].includes(k) && t.includes(`{{${k}}}`)).map(([k]) => k);
  if (s.kind === 'spike') for (const k of ['MUTATE_COMMAND']) { const i = empty.indexOf(k); if (i >= 0) empty.splice(i, 1); }
  if (empty.length) fail(`cannot fill the prompt; no value for: ${empty.join(', ')}. Set them in factory.config.json (commands, owner_only, builder_must_not_read) or prompts/PROJECT.md.`);
  t = t.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in values ? values[k] : m));
  const left = [...new Set(t.match(/\{\{[A-Z_]+\}\}/g) || [])];
  if (left.length) fail(`the template has tokens this tool does not know: ${left.join(', ')}`);
  const out = path.join(plan, 'handback', `${id}-PROMPT.md`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, t);
  return {
    prompt_file: out, session: id, kind: s.kind || 'build',
    worktree: values.WORKTREE, branch: values.BRANCH, previous_tag: values.PREVIOUS_TAG,
    run_id: bridgeRun(cfg, id).run,
    next: [
      `git -C "${cfg.repo}" worktree add "${values.WORKTREE}" -b ${values.BRANCH} ${cfg.main_branch}`,
      cfg.commands?.install ? `(in the worktree) ${cfg.commands.install}` : null,
      `opencode_start id=${bridgeRun(cfg, id).run} dir="${values.WORKTREE}" prompt_file="${out}" model="${cfg.builder?.model || ''}" config="${cfg.builder?.config || ''}"`,
    ].filter(Boolean),
  };
}

function cmdCheckHandback(o) {
  const { plan, sessions } = load(o);
  const id = o._[0];
  if (!sessions.find((x) => x.id === id)) fail(`session "${id}" is not in plan/phases.json`);
  const hb = handbackState(plan, id);
  if (!hb.present) return { ok: false, session: id, present: false, note: 'no handback.md: the turn ended unfinished, or the builder wrote it somewhere else' };
  return { ok: hb.headings_ok, session: id, ...hb };
}

function cmdInit(o) {
  const repo = path.resolve(o.repo || process.cwd());
  let top;
  try { top = path.resolve(git(repo, ['rev-parse', '--show-toplevel'])); } catch { fail(`${repo} is not a git repository`); }
  const plan = path.resolve(o.plan || path.join(top, PLAN_NAME));
  const cfgPath = path.join(plan, 'factory.config.json');
  if (fs.existsSync(cfgPath)) fail(`${cfgPath} exists; this project is already set up`);
  for (const d of ['audit/reviewers', 'direction', 'plan/areas', 'fixtures', 'plan-review', 'prompts', 'handback']) fs.mkdirSync(path.join(plan, d), { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'factory.config.json'), 'utf8'));
  cfg.project = o.project || path.basename(top);
  cfg.repo = top;
  cfg.worktree_root = path.join(path.dirname(top), path.basename(top) + '-wt');
  cfg.plan_committed = !!o.commitPlan;
  try { cfg.main_branch = git(top, ['symbolic-ref', '--short', 'HEAD']); } catch {}
  cfg.builder.config = path.join(ROOT, 'bridge', 'configs', 'no-deploy-no-push.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  fs.writeFileSync(path.join(plan, 'plan', 'phases.json'), '[]\n');
  fs.writeFileSync(path.join(plan, 'handback', 'PROGRESS.md'), fs.readFileSync(path.join(ROOT, 'templates', 'progress.md'), 'utf8').replace('<project>', cfg.project));
  let excluded = false;
  const rel = path.relative(top, plan).split(path.sep).join('/');
  if (!cfg.plan_committed && rel && !rel.startsWith('..')) {
    const ex = path.resolve(top, git(top, ['rev-parse', '--git-path', 'info/exclude']));
    const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
    if (!cur.split(/\r?\n/).includes(`/${rel}/`)) {
      fs.mkdirSync(path.dirname(ex), { recursive: true });
      fs.writeFileSync(ex, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + `/${rel}/\n`);
    }
    excluded = true;
  }
  return {
    plan, config: cfgPath, project: cfg.project, kept_out_of_git: excluded,
    set_next: ['builder.model', 'commands.install', 'commands.phase and commands.mutate (once the plan names them; use {session})', 'builder_must_not_read', 'review owner_only and stop_policy with the owner'],
  };
}

// Every setting a person may change, with its type and what it means. `show` prints these;
// `set`, `add` and `remove` refuse a key that is not here, so a typo cannot add a dead setting.
const SETTINGS = {
  project: ['string', 'The name used in prompts, logs and run ids.'],
  main_branch: ['string', 'The branch accepted sessions are merged to.'],
  worktree_root: ['string', 'Where session worktrees and review clones go. Keep it short.'],
  branch_prefix: ['string', 'A session S is built on <prefix>S.'],
  tag_prefix: ['string', 'A session S is accepted as the tag <prefix>S.'],
  plan_committed: ['boolean', 'Whether the plan folder is committed to the repository.'],
  'builder.model': ['string', 'The model the builder runs on, as `opencode models` prints it.'],
  'builder.config': ['string', 'The builder\'s rules file: which commands it is refused.'],
  'builder.thinking': ['boolean', 'Write the builder\'s reasoning to its log as well as its actions.'],
  'commands.install': ['string', 'What a clean clone needs before anything runs.'],
  'commands.phase': ['string', 'The one command that decides a session; {session} is replaced.'],
  'commands.mutate': ['string', 'The mutation run; {session} is replaced.'],
  'stop_policy.failed_reviews': ['number', 'Failed reviews of one session before the loop waits for the owner.'],
  'stop_policy.unfinished_turns': ['number', 'Builder turns ending with no handback before the loop waits.'],
  'stop_policy.stalls': ['number', 'Stalled waits before the loop waits for the owner.'],
  'stop_policy.push_after_accept': ['boolean', 'Push the main branch and the tag after each accepted session.'],
  'limits.max_subagents': ['number', 'Helper agents that may run at once. Lower it on a small machine.'],
  'limits.parallel_sessions': ['number', 'Builder sessions at once. Keep 1 unless the machine and the plan allow more.'],
  'models.audit_reviewer': ['model', 'Model for the four audit reviewers. Empty: same as the chat.'],
  'models.finding_verifier': ['model', 'Model for the agent that tries to disprove findings.'],
  'models.plan_reviewer': ['model', 'Model for the plan reviewers. Worth the strongest model in round 1.'],
  'models.session_reviewer': ['model', 'Model for the clean-clone review of each session.'],
  'models.read_list_drafter': ['model', 'Model for drafting each session\'s reading list.'],
  owner_only: ['list', 'Actions no agent takes.'],
  builder_must_not_read: ['list', 'Paths the builder is told not to open.'],
};

function configFile(o) { return path.join(findPlan(o), 'factory.config.json'); }
function readCfg(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail('factory.config.json is not valid JSON: ' + e.message); } }
function getPath(obj, key) { return key.split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj); }
function setPath(obj, key, v) {
  const ks = key.split('.');
  let a = obj;
  for (const k of ks.slice(0, -1)) { if (typeof a[k] !== 'object' || a[k] === null) a[k] = {}; a = a[k]; }
  a[ks[ks.length - 1]] = v;
}
function knownKey(key) {
  if (!SETTINGS[key]) fail(`unknown setting "${key}". Known: ${Object.keys(SETTINGS).join(', ')}`);
  return SETTINGS[key];
}

function cmdShow(o) {
  const file = configFile(o);
  const cfg = readCfg(file);
  const settings = Object.entries(SETTINGS).map(([key, [type, meaning]]) => {
    const v = getPath(cfg, key);
    return { key, value: v === undefined ? (type === 'list' ? [] : '') : v, type, meaning };
  });
  const needed = [];
  if (!cfg.builder?.model) needed.push('builder.model (before the build stage)');
  if (!cfg.commands?.phase) needed.push('commands.phase (set at the plan stage)');
  if (!cfg.commands?.install) needed.push('commands.install (if a clean clone needs one)');
  return { config: file, repo: cfg.repo, settings, still_empty: needed };
}

function cmdSet(o) {
  const [key, ...rest] = o._;
  const [type] = knownKey(key);
  if (type === 'list') fail(`"${key}" is a list: use add or remove`);
  if (!rest.length) fail('usage: set <key> <value>   (use "" to clear a text or model setting)');
  const raw = rest.join(' ');
  let v = raw;
  if (type === 'number') { v = Number(raw); if (!Number.isInteger(v) || v < 0) fail(`"${key}" takes a whole number, 0 or more`); }
  if (type === 'boolean') { if (!/^(true|false|yes|no|on|off)$/i.test(raw)) fail(`"${key}" takes true or false`); v = /^(true|yes|on)$/i.test(raw); }
  if (type === 'model' && /\s/.test(raw)) fail(`"${key}" takes one model name, or "" for the chat's own model`);
  if (key === 'limits.max_subagents' && v < 1) fail('limits.max_subagents must be at least 1');
  if (key === 'builder.config' && raw && !fs.existsSync(raw)) fail(`file not found: ${raw}`);
  if (['project', 'main_branch', 'worktree_root', 'branch_prefix', 'tag_prefix'].includes(key) && !raw) fail(`"${key}" cannot be empty`);
  const file = configFile(o);
  const cfg = readCfg(file);
  const before = getPath(cfg, key);
  setPath(cfg, key, v);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return { key, before: before === undefined ? null : before, after: v };
}

function cmdList(o, add) {
  const [key, ...rest] = o._;
  const [type] = knownKey(key);
  if (type !== 'list') fail(`"${key}" is not a list: use set`);
  const item = rest.join(' ').trim() || fail(`usage: ${add ? 'add' : 'remove'} <key> <item>`);
  const file = configFile(o);
  const cfg = readCfg(file);
  const cur = Array.isArray(cfg[key]) ? cfg[key] : [];
  const has = cur.includes(item);
  if (add && has) return { key, changed: false, items: cur };
  if (!add && !has) fail(`"${item}" is not in ${key}. Items: ${JSON.stringify(cur)}`);
  cfg[key] = add ? [...cur, item] : cur.filter((x) => x !== item);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return { key, changed: true, items: cfg[key] };
}

const cmds = {
  init: cmdInit, where: cmdWhere, prompt: cmdPrompt, 'check-handback': cmdCheckHandback,
  show: cmdShow, set: cmdSet, add: (o) => cmdList(o, true), remove: (o) => cmdList(o, false),
};
const [name, ...rest] = process.argv.slice(2);
try {
  if (!cmds[name]) { console.log('usage: factory.mjs init | where | prompt <session> --notes-file <f> | check-handback <session> | show | set <key> <value> | add <key> <item> | remove <key> <item>   [--plan <dir>]'); process.exit(2); }
  const out = cmds[name](parseArgs(rest));
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok === false ? 1 : 0);
} catch (e) {
  if (e instanceof Fail) { console.error('factory: ' + e.message); process.exit(2); }
  throw e;
}

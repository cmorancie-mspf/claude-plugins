#!/usr/bin/env node
// rebuild-factory helper: the deterministic parts of the loop. No dependencies.
//
//   node factory.mjs init [--repo <path>] [--plan <dir>] [--project <name>] [--commit-plan]
//   node factory.mjs doctor [--stage build]        is this machine, and this project, ready? Calls no model.
//   node factory.mjs trust [--yes]                 show what a plan folder will make agents run; --yes accepts it
//   node factory.mjs where
//   node factory.mjs prompt <session> --notes-file <file>
//   node factory.mjs check-handback <session>
//   node factory.mjs accept <session>              record a session as accepted, after its review, merge and tag
//   node factory.mjs seal <session>                record the plan folder's contents before a builder turn
//   node factory.mjs check-seal <session>          what changed in the plan folder since the seal
//   node factory.mjs show                          every setting, its value and its meaning
//   node factory.mjs set <key> <value...>          for example: set builder.model provider/model
//   node factory.mjs unset <key>                   clear a text or model setting
//   node factory.mjs add|remove <key> <item...>    for the list settings
//
// Every command takes --plan <dir> first. Without it, the plan folder is the nearest factory-plan/
// at or above the current folder.
//
// A plan folder is trusted only on the machine where `init` or `trust --yes` was run for it: its
// config names commands that agents will run. A folder that arrived by clone is refused until the
// owner has seen those values. The records of what was accepted (the plan folder, each session,
// the seal) are kept in the user's home folder (~/.rebuild-factory), never in the repository.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAN_NAME = 'factory-plan';
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
const HANDBACK_HEADINGS = [
  'Identity', 'Summary', 'Phase command', 'Acceptance tests', 'Requirements', 'Mutations', 'Opt-outs',
  'Changes to earlier tests, fixtures or harness', 'Spikes', 'Deviations from the plan', 'Not done',
  'Needs the owner', 'Files', 'Least sure of',
];
// Commands a rules file should refuse. doctor tries each against the file's deny patterns.
const RULE_SAMPLES = [
  'git push origin main', 'git -C . push', 'git push --force', 'cd app && git push', 'git tag -m accepted accepted/1a main',
  'npm publish', 'npm run deploy', 'gh release create v1', 'docker push app', 'terraform apply', 'kubectl apply -f k.yml',
  'node /plugins/rebuild-factory/scripts/factory.mjs trust --yes',
];
// Ordinary work a rules file should not refuse. doctor warns when one of these is caught.
const RULE_HARMLESS = [
  'git status', 'git commit -m "test: the push handler"', 'git stash push', 'git log --grep=push', 'git remote -v && git add .',
  'npm install', 'npm test', 'npm run release-notes', 'ls vercel.json', 'node test/samples/deploy-plan.test.js',
];

class Fail extends Error {}
const fail = (m) => { throw new Fail(m); };
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const readOr = (file, dflt = null) => { try { return fs.readFileSync(file, 'utf8'); } catch { return dflt; } };

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit-plan') o.commitPlan = true;
    else if (a === '--yes') o.yes = true;
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

function readCfg(file) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail('factory.config.json is not valid JSON: ' + e.message); }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) fail('factory.config.json must be a JSON object');
  return cfg;
}

function checkShape(cfg) {
  for (const k of ['project', 'repo', 'worktree_root', 'main_branch', 'branch_prefix', 'tag_prefix']) {
    if (typeof cfg[k] !== 'string' || !cfg[k]) fail(`factory.config.json: "${k}" is empty`);
  }
  if (!PROJECT_RE.test(cfg.project)) fail(`factory.config.json: project "${cfg.project}" must be letters, digits, _ and -, at most 32, starting with a letter or digit`);
  for (const k of ['main_branch', 'branch_prefix', 'tag_prefix']) {
    if (!REF_RE.test(cfg[k])) fail(`factory.config.json: ${k} "${cfg[k]}" holds characters that are not allowed in a branch or tag name`);
  }
}

// ---- trust: a plan folder is believed only where its owner has accepted it

// Records of what the owner accepted are kept in the user's home folder, never in the
// repository or the plan folder: nothing that arrives by clone can carry one.
const STORE = process.env.REBUILD_FACTORY_HOME && path.isAbsolute(process.env.REBUILD_FACTORY_HOME)
  ? process.env.REBUILD_FACTORY_HOME : path.join(os.homedir(), '.rebuild-factory');
const planKey = (plan) => sha(fs.realpathSync(plan).toLowerCase()).slice(0, 24);
const storeFile = (plan, kind) => path.join(STORE, `${planKey(plan)}.${kind}.json`);
const readStore = (plan, kind) => { try { return JSON.parse(fs.readFileSync(storeFile(plan, kind), 'utf8')); } catch { return null; } };
const writeStore = (plan, kind, data) => { fs.mkdirSync(STORE, { recursive: true }); fs.writeFileSync(storeFile(plan, kind), JSON.stringify(data, null, 2) + '\n'); };

// The repository a config names must be a real working repository at an absolute path.
function checkRepo(cfg) {
  for (const k of ['repo', 'worktree_root']) if (!path.isAbsolute(cfg[k])) fail(`factory.config.json: ${k} must be an absolute path`);
  if (cfg.builder?.config && !path.isAbsolute(cfg.builder.config)) fail('factory.config.json: builder.config must be an absolute path');
  let top, bare;
  try { bare = git(cfg.repo, ['rev-parse', '--is-bare-repository']); top = git(cfg.repo, ['rev-parse', '--show-toplevel']); }
  catch { fail(`factory.config.json: repo is not a git working repository: ${cfg.repo}`); }
  if (bare !== 'false' || !samePath(top, cfg.repo)) fail(`factory.config.json: repo must be the top folder of a git working repository: ${cfg.repo}`);
}

// Everything in a plan folder that decides what an agent runs or may do.
function trustView(plan, cfg) {
  const rules = cfg.builder?.config ? readOr(cfg.builder.config) : null;
  return {
    repo: cfg.repo, main_branch: cfg.main_branch, branch_prefix: cfg.branch_prefix, tag_prefix: cfg.tag_prefix,
    worktree_root: cfg.worktree_root,
    commands: cfg.commands || {},
    builder: { model: cfg.builder?.model || '', config: cfg.builder?.config || '', thinking: !!cfg.builder?.thinking },
    rules_sha256: rules === null ? null : sha(rules),
    owner_only: cfg.owner_only || [],
    builder_must_not_read: cfg.builder_must_not_read || [],
    stop_policy: cfg.stop_policy || {},
    limits: cfg.limits || {},
    kickoff_sha256: sha(readOr(path.join(plan, 'prompts', 'KICKOFF.md'), '')),
    project_paragraph_sha256: sha(readOr(path.join(plan, 'prompts', 'PROJECT.md'), '')),
  };
}
const fingerprint = (plan, cfg) => sha(JSON.stringify(trustView(plan, cfg)));
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function trustState(plan, cfg) {
  const rec = readStore(plan, 'trust');
  if (!rec) return { trusted: false, reason: 'this plan folder was not set up on this machine' };
  if (!samePath(rec.plan || '', plan)) return { trusted: false, reason: 'the trust record on this machine is for a different plan folder' };
  if (rec.fingerprint !== fingerprint(plan, cfg)) return { trusted: false, reason: 'its commands, rules file, builder settings or kickoff prompt have changed since the owner accepted them' };
  return { trusted: true };
}

function writeTrust(plan, cfg) {
  writeStore(plan, 'trust', { plan: fs.realpathSync(plan), fingerprint: fingerprint(plan, cfg), at: new Date().toISOString() });
}

const UNTRUSTED = (reason) => `${reason}. Its config names commands that agents will run. Show the owner what it holds with \`factory.mjs trust\`, and accept it with \`factory.mjs trust --yes\` only when the owner agrees.`;

function load(o, { needTrust = true } = {}) {
  const plan = findPlan(o);
  const cfg = readCfg(path.join(plan, 'factory.config.json'));
  checkShape(cfg);
  if (needTrust) {
    const t = trustState(plan, cfg);
    if (!t.trusted) fail(UNTRUSTED(t.reason));
  }
  checkRepo(cfg);
  let sessions = [];
  const pj = path.join(plan, 'plan', 'phases.json');
  if (fs.existsSync(pj)) {
    try { sessions = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch (e) { fail('plan/phases.json is not valid JSON: ' + e.message); }
    if (!Array.isArray(sessions)) fail('plan/phases.json must be an array of sessions');
    const seen = new Set();
    for (const s of sessions) {
      if (!s || !SESSION_RE.test(s.id || '')) fail(`plan/phases.json: bad session id ${JSON.stringify(s && s.id)}`);
      if (seen.has(s.id)) fail(`plan/phases.json: session ${s.id} is listed twice`);
      if (s.id === 'baseline') fail('plan/phases.json: "baseline" is the name of the starting tag and cannot be a session id');
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

// What a tag must be to stand for an accepted session: annotated, on a merge commit, and that
// commit on the main branch.
function tagFacts(cfg, t) {
  try {
    if (git(cfg.repo, ['cat-file', '-t', 'refs/tags/' + t]) !== 'tag') return { ok: false, why: 'it is not an annotated tag' };
    const object = git(cfg.repo, ['rev-parse', 'refs/tags/' + t]);
    const commit = git(cfg.repo, ['rev-parse', `refs/tags/${t}^{commit}`]);
    const parents = git(cfg.repo, ['rev-list', '--parents', '-n', '1', commit]).split(' ').length - 1;
    if (parents < 2) return { ok: false, why: 'its commit is not a merge commit' };
    try { git(cfg.repo, ['merge-base', '--is-ancestor', commit, cfg.main_branch]); } catch { return { ok: false, why: 'its commit is not on the main branch' }; }
    return { ok: true, object, commit };
  } catch { return { ok: false, why: 'it cannot be read' }; }
}

// A session counts as accepted only when the conductor recorded the acceptance on this machine
// (`accept`, after a passed review and the merge) and the tag is still the object that was
// recorded. The record is outside the repository, so a builder that creates a tag, however well
// formed, does not make a session accepted.
function tags(cfg, plan) {
  let names;
  try { names = git(cfg.repo, ['tag', '-l', cfg.tag_prefix + '*']).split(/\r?\n/).filter(Boolean); }
  catch { fail(`cannot read git tags in ${cfg.repo}`); }
  const recorded = (readStore(plan, 'accepted') || {}).sessions || {};
  const ok = new Set();
  const suspect = [];
  for (const t of names) {
    if (t === cfg.tag_prefix + 'baseline') { ok.add(t); continue; }
    const id = t.slice(cfg.tag_prefix.length);
    const rec = recorded[id];
    const facts = tagFacts(cfg, t);
    if (rec && facts.ok && rec.tag_object === facts.object) ok.add(t);
    else suspect.push({ tag: t, why: !facts.ok ? facts.why : !rec ? 'no acceptance was recorded for it on this machine' : 'it is not the tag that was recorded at acceptance' });
  }
  return { ok, suspect };
}

function cmdAccept(o) {
  const { plan, cfg, sessions } = load(o);
  const id = o._[0];
  if (!sessions.find((x) => x.id === id)) fail(`session "${id}" is not in plan/phases.json`);
  const t = cfg.tag_prefix + id;
  const facts = tagFacts(cfg, t);
  if (!facts.ok) fail(`cannot record ${id} as accepted: the tag ${t} is missing, or ${facts.why}. Merge the session to ${cfg.main_branch} with --no-ff, then create the annotated tag on that merge commit.`);
  if (!fs.existsSync(path.join(plan, 'handback', id, 'REVIEW.md'))) fail(`cannot record ${id} as accepted: there is no handback/${id}/REVIEW.md. Acceptance follows a written review.`);
  const rec = readStore(plan, 'accepted') || { plan: fs.realpathSync(plan), sessions: {} };
  rec.sessions[id] = { tag_object: facts.object, commit: facts.commit, at: new Date().toISOString() };
  writeStore(plan, 'accepted', rec);
  return { accepted: id, tag: t, commit: facts.commit };
}

// One machine-wide folder holds every project's runs, so the id carries the repository too.
function runId(cfg, id) {
  return `${cfg.project}-${sha(path.resolve(cfg.repo).toLowerCase()).slice(0, 6)}-${id}`;
}

function bridgeRun(cfg, id) {
  const home = process.env.OC_BRIDGE_HOME || path.join(os.homedir(), '.oc-bridge');
  const run = runId(cfg, id);
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
  const where = {};
  HANDBACK_HEADINGS.forEach((h, n) => {
    const re = new RegExp(`^#{1,4}\\s*${n}[.):]?\\s+${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
    const i = lines.findIndex((l, k) => k > at && re.test(l.trim()));
    if (i < 0) missing.push(`${n}. ${h}`); else { at = i; where[n] = i; }
  });
  const section = (n) => {
    if (!(n in where)) return [];
    const out = [];
    for (let i = where[n] + 1; i < lines.length && !/^#{1,4}\s/.test(lines[i]); i++) out.push(lines[i]);
    return out;
  };
  const firstOf = (n) => section(n).find((l) => l.trim()) || '';
  const blocked = /^[*_`\s-]*blocked\b/i.test(firstOf(10));
  // A handback that is the untouched template names no commit.
  const identityFilled = /\b[0-9a-f]{7,40}\b/.test(section(0).join('\n'));
  return { present: true, file: f, headings_ok: missing.length === 0, missing, identity_filled: identityFilled, blocked };
}

function sessionState({ plan, cfg }, s, tagSet) {
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
    : st.review && hb.present ? 'a review file exists and the session is not accepted: findings are with the builder, the builder has handed back again, or the merge is pending. Read the review and the run status.'
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
  const { ok: tagSet, suspect } = tags(cfg, plan);
  const has = (s) => tagSet.has(cfg.tag_prefix + s.id);
  const accepted = sessions.filter(has).map((s) => s.id);
  const first = sessions.find((s) => !has(s));
  const outOfOrder = first ? sessions.slice(sessions.indexOf(first)).filter(has).map((s) => s.id) : [];
  const out = { plan, project: cfg.project, sessions: sessions.length, accepted: accepted.length, remaining: sessions.length - accepted.length, next: first ? sessionState(ctx, first, tagSet) : null };
  if (outOfOrder.length) out.warning = `accepted out of order, after the next session: ${outOfOrder.join(', ')}`;
  if (suspect.length) out.suspect_tags = { tags: suspect, meaning: 'these tags do not count as acceptance. If you created one after a passed review and the merge, record it with: accept <session>. If you did not create it, something else did: treat it as a finding and tell the owner.' };
  if (first && (first.paid || first.gate)) out.stop_for_owner = first.paid ? 'this session has a paid or live test: say what it will spend and wait' : `gate: ${first.gate}`;
  if (!first) out.note = 'every session is accepted';
  return out;
}

function rulesFileOf(cfg) {
  const f = cfg.builder?.config;
  if (!f) fail('builder.config is not set. A builder runs auto-approved, so it must have a rules file. Set it with: set builder.config <file>');
  if (!fs.existsSync(f)) fail(`the builder's rules file does not exist: ${f}`);
  return f;
}

function cmdPrompt(o) {
  const ctx = load(o);
  const { cfg, sessions, plan } = ctx;
  const id = o._[0];
  const s = sessions.find((x) => x.id === id) || fail(`session "${id}" is not in plan/phases.json`);
  const rl = readLine(plan, id);
  if (!rl.block) fail(`no block "### Session ${id}" in plan/phases.md`);
  if (!rl.filled) fail(`session ${id} is not ready: its Read line is not filled`);
  const rules = rulesFileOf(cfg);
  if (!o.notesFile) fail('pass --notes-file: the notes for this session (what the last review found, what to watch for). A file that says "None." is allowed for a first session.');
  const notesPath = path.resolve(o.notesFile);
  if (!fs.existsSync(notesPath)) fail(`notes file not found: ${notesPath}`);
  const notes = fs.readFileSync(notesPath, 'utf8').trim() || fail('the notes file is empty');
  const own = path.join(plan, 'prompts', 'KICKOFF.md');
  let t = fs.readFileSync(fs.existsSync(own) ? own : path.join(ROOT, 'templates', 'kickoff-prompt.md'), 'utf8');
  const { ok: tagSet } = tags(cfg, plan);
  const before = sessions.slice(0, sessions.indexOf(s)).filter((x) => tagSet.has(cfg.tag_prefix + x.id));
  const cmd = (c) => (c || '').replaceAll('{session}', id);
  const values = {
    SESSION: id, PROJECT: cfg.project, WORKTREE: path.join(cfg.worktree_root, id), BRANCH: cfg.branch_prefix + id,
    PLAN_DIR: plan, PREVIOUS_TAG: before.length ? cfg.tag_prefix + before[before.length - 1].id : cfg.tag_prefix + 'baseline',
    PHASE_COMMAND: cmd(cfg.commands?.phase), MUTATE_COMMAND: cmd(cfg.commands?.mutate),
    OWNER_ONLY: (cfg.owner_only || []).join('; '),
    MUST_NOT_READ: (cfg.builder_must_not_read || []).map((p) => '`' + p + '`').join(', '),
    PROJECT_PARAGRAPH: (readOr(path.join(plan, 'prompts', 'PROJECT.md'), '') || '').trim(),
    SPIKE_BLOCK: s.kind === 'spike' ? fs.readFileSync(path.join(ROOT, 'templates', 'spike-block.md'), 'utf8') : '',
    NOTES: notes,
  };
  // Checked on the template, before filling: notes may quote a {{TOKEN}} of their own.
  const unknown = [...new Set(t.match(/\{\{[A-Z_]+\}\}/g) || [])].filter((k) => !(k.slice(2, -2) in values));
  if (unknown.length) fail(`the template has tokens this tool does not know: ${unknown.join(', ')}`);
  const empty = Object.entries(values).filter(([k, v]) => !v && k !== 'SPIKE_BLOCK' && t.includes(`{{${k}}}`)).map(([k]) => k);
  if (s.kind === 'spike') { const i = empty.indexOf('MUTATE_COMMAND'); if (i >= 0) empty.splice(i, 1); }
  if (empty.length) fail(`cannot fill the prompt; no value for: ${empty.join(', ')}. Set them with factory.mjs set (commands.*), add (owner_only, builder_must_not_read), or write prompts/PROJECT.md.`);
  t = t.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => values[k]);
  const out = path.join(plan, 'handback', `${id}-PROMPT.md`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, t);
  const run = runId(cfg, id);
  return {
    prompt_file: out, session: id, kind: s.kind || 'build',
    worktree: values.WORKTREE, branch: values.BRANCH, previous_tag: values.PREVIOUS_TAG, run_id: run,
    next: [
      `git -C "${cfg.repo}" worktree add "${values.WORKTREE}" -b ${values.BRANCH} ${cfg.main_branch}`,
      cfg.commands?.install ? `in the worktree, the install command the owner set: ${cfg.commands.install}` : null,
      `factory.mjs seal ${id}`,
      `opencode_start id=${run} dir="${values.WORKTREE}" prompt_file="${out}" model="${cfg.builder?.model || ''}" config="${rules}"`,
    ].filter(Boolean),
  };
}

function cmdCheckHandback(o) {
  const { plan, sessions } = load(o);
  const id = o._[0];
  if (!sessions.find((x) => x.id === id)) fail(`session "${id}" is not in plan/phases.json`);
  const hb = handbackState(plan, id);
  if (!hb.present) return { ok: false, session: id, present: false, note: 'no handback.md: the turn ended unfinished, or the builder wrote it somewhere else' };
  const out = { ok: hb.headings_ok && hb.identity_filled, session: id, ...hb };
  if (hb.headings_ok && !hb.identity_filled) out.note = 'the headings are there but Identity names no commit: this looks like the empty template';
  return out;
}

// ---- seal: notice a plan folder that changed while a builder was running

function walk(dir, base = dir, out = {}) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out[path.relative(base, p).split(path.sep).join('/')] = sha(fs.readFileSync(p));
  }
  return out;
}

function planSnapshot(plan, cfg, id) {
  const own = `handback/${id}/`;
  const files = Object.fromEntries(Object.entries(walk(plan)).filter(([rel]) => !rel.startsWith(own)));
  const rules = cfg.builder?.config ? readOr(cfg.builder.config) : null;
  return { files, rules_sha256: rules === null ? null : sha(rules) };
}

function cmdSeal(o) {
  const { plan, cfg, sessions } = load(o);
  const id = o._[0];
  if (!sessions.find((x) => x.id === id)) fail(`session "${id}" is not in plan/phases.json`);
  const snap = planSnapshot(plan, cfg, id);
  writeStore(plan, 'seal', { session: id, plan: fs.realpathSync(plan), at: new Date().toISOString(), ...snap });
  return { sealed: id, files: Object.keys(snap.files).length, note: `everything in the plan folder except handback/${id}/ is recorded. Seal again after any change you make to the plan yourself.` };
}

function cmdCheckSeal(o) {
  // Runs even when the plan is no longer accepted: a changed rules file is exactly what it must report.
  const { plan, cfg } = load(o, { needTrust: false });
  const trusted = trustState(plan, cfg).trusted;
  const id = o._[0];
  const rec = readStore(plan, 'seal') || fail('no seal recorded: run seal <session> before starting the builder');
  if (rec.session !== id) fail(`the recorded seal is for session ${rec.session}, not ${id}`);
  const now = planSnapshot(plan, cfg, id);
  const changed = Object.keys(now.files).filter((f) => f in rec.files && rec.files[f] !== now.files[f]);
  const added = Object.keys(now.files).filter((f) => !(f in rec.files));
  const removed = Object.keys(rec.files).filter((f) => !(f in now.files));
  const rulesChanged = rec.rules_sha256 !== now.rules_sha256;
  const ok = !changed.length && !added.length && !removed.length && !rulesChanged && trusted;
  return {
    ok, session: id, sealed_at: rec.at, changed, added, removed, rules_file_changed: rulesChanged, plan_still_accepted: trusted,
    ...(ok ? {} : { meaning: `the plan folder or the rules file changed since the seal. The builder may write only under handback/${id}/. Unless you made these changes yourself, each one is a finding: do not review or continue the session as if they were the plan.` }),
  };
}

// ---- init

function cmdInit(o) {
  const repo = path.resolve(o.repo || process.cwd());
  let top;
  try { top = path.resolve(git(repo, ['rev-parse', '--show-toplevel'])); } catch { fail(`${repo} is not a git repository`); }
  const plan = path.resolve(o.plan || path.join(top, PLAN_NAME));
  const cfgPath = path.join(plan, 'factory.config.json');
  if (fs.existsSync(cfgPath)) {
    const t = trustState(plan, readCfg(cfgPath));
    fail(t.trusted ? `${cfgPath} exists; this project is already set up`
      : `${cfgPath} exists, but ${UNTRUSTED(t.reason)}`);
  }
  const base = path.basename(top);
  const project = o.project || base.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 32) || 'project';
  if (!PROJECT_RE.test(project)) fail(`project name "${project}" must be letters, digits, _ and -, at most 32, starting with a letter or digit; pass --project <name>`);
  for (const d of ['audit/reviewers', 'direction', 'plan/areas', 'fixtures', 'plan-review', 'prompts', 'handback']) fs.mkdirSync(path.join(plan, d), { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'factory.config.json'), 'utf8'));
  cfg.project = project;
  cfg.repo = top;
  cfg.worktree_root = path.join(path.dirname(top), base + '-wt');
  cfg.plan_committed = !!o.commitPlan;
  try { cfg.main_branch = git(top, ['symbolic-ref', '--short', 'HEAD']); } catch {}
  // The project gets its own copy of the rules file: editing the one inside the plugin would
  // change every project and be lost on a plugin update.
  const rules = path.join(plan, 'builder-rules.json');
  fs.copyFileSync(path.join(ROOT, 'bridge', 'configs', 'no-deploy-no-push.json'), rules);
  cfg.builder.config = rules;
  checkShape(cfg);
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
  writeTrust(plan, cfg);
  return {
    plan, config: cfgPath, project: cfg.project, kept_out_of_git: excluded, builder_rules: rules,
    set_next: ['builder.model', 'commands.install', 'commands.phase and commands.mutate (once the plan names them; use {session})', 'builder_must_not_read', 'review owner_only, stop_policy and builder-rules.json with the owner', `tag the starting commit: git tag ${cfg.tag_prefix}baseline`],
  };
}

// The project's kickoff prompt, as the lines in which it differs from the plugin's template:
// those are the lines someone wrote, and every one of them is shown.
function diffFromTemplate(kickoff) {
  const norm = (t) => t.replace(/\r\n/g, '\n').trimEnd();
  const tplText = fs.readFileSync(path.join(ROOT, 'templates', 'kickoff-prompt.md'), 'utf8');
  if (norm(kickoff) === norm(tplText)) return 'identical to the plugin\'s template';
  const lines = (t) => norm(t).split('\n');
  const tplSet = new Set(lines(tplText).map((l) => l.trim()));
  const ownSet = new Set(lines(kickoff).map((l) => l.trim()));
  const added = lines(kickoff).map((l, i) => [i + 1, l]).filter(([, l]) => l.trim() && !tplSet.has(l.trim()));
  const removed = lines(tplText).map((l, i) => [i + 1, l]).filter(([, l]) => l.trim() && !ownSet.has(l.trim()));
  const show = (rows) => rows.map(([n, l]) => `  ${n}: ${l}`).join('\n');
  return 'it differs from the plugin\'s template.'
    + (added.length ? `\n${added.length} line(s) ADDED (line numbers in this project's prompt):\n${show(added)}` : '')
    + (removed.length ? `\n${removed.length} line(s) of the template REMOVED (line numbers in the template). A removed line is often a safety instruction:\n${show(removed)}` : '')
    + (!added.length && !removed.length ? '\nThe same lines in a different order or number: read the file itself.' : '');
}

// A rules file may hold the schema line and permissions, and nothing else. Any other key
// (an MCP server, a command, a plugin, an agent) is something OpenCode would load or run.
function rulesExtras(text) {
  let j;
  try { j = JSON.parse(text); } catch { return ['(not readable JSON)']; }
  const out = Object.keys(j).filter((k) => k !== '$schema' && k !== 'permission');
  // Under permission.bash only one entry may allow anything: "*": "allow", and only as the first
  // entry. Which rule wins when two match depends on their order, so an allow placed after the
  // denies, or a narrower allow, could switch a deny off while the deny is still listed.
  const bash = j.permission?.bash;
  if (bash && typeof bash === 'object') {
    Object.entries(bash).forEach(([k, v], i) => {
      if (v === 'deny') return;
      if (!(i === 0 && k === '*' && v === 'allow')) out.push(`a shell rule that is not a deny: "${k}": ${JSON.stringify(v)}${k === '*' ? ' (it must be the first entry)' : ''}`);
    });
  }
  return out;
}

function cmdTrust(o) {
  const plan = findPlan(o);
  const cfg = readCfg(path.join(plan, 'factory.config.json'));
  checkShape(cfg);
  checkRepo(cfg);
  const state = trustState(plan, cfg);
  const rulesText = cfg.builder?.config ? readOr(cfg.builder.config) : null;
  let denies = null;
  try { const b = JSON.parse(rulesText).permission?.bash; denies = b === 'deny' ? ['(every command)'] : Object.entries(b || {}).filter(([, v]) => v === 'deny').map(([k]) => k); } catch { /* shown as unreadable */ }
  const progress = readOr(path.join(plan, 'handback', 'PROGRESS.md'), '') || '';
  const standing = (progress.match(/## Standing instructions[^\n]*\n([\s\S]*?)(?=\n## |\n<!--|$)/) || [, ''])[1].trim();
  const kickoff = readOr(path.join(plan, 'prompts', 'KICKOFF.md'));
  const view = {
    plan,
    trusted_now: state.trusted,
    ...(state.trusted ? {} : { why_not: state.reason }),
    commands_agents_will_run: cfg.commands || {},
    builder_model: cfg.builder?.model || '(not set)',
    builder_rules_file: cfg.builder?.config || '(not set)',
    rules_refuse: denies === null ? '(the rules file is missing or unreadable)' : denies,
    rules_file_also_holds: rulesText === null ? [] : rulesExtras(rulesText),
    no_agent_may: cfg.owner_only || [],
    builder_told_not_to_read: cfg.builder_must_not_read || [],
    stop_policy: cfg.stop_policy || {},
    worktrees_go_in: cfg.worktree_root,
    own_kickoff_prompt: kickoff === null ? 'none: the plugin\'s template is used' : diffFromTemplate(kickoff),
    project_paragraph_given_to_the_builder: readOr(path.join(plan, 'prompts', 'PROJECT.md'), '') || 'none',
    standing_instructions_in_progress_log: standing || 'none',
  };
  const extras = rulesText === null ? [] : rulesExtras(rulesText);
  if (extras.length) {
    view.next = `REFUSED: the rules file holds more than deny rules (${extras.join('; ')}). A key other than "$schema" and "permission" is something OpenCode would load or run; a shell rule other than a first "*": "allow" followed by denies could switch a deny off. Correct ${cfg.builder.config} before this folder can be accepted.`;
    if (o.yes) fail(view.next);
    return view;
  }
  if (!o.yes) {
    view.next = state.trusted ? 'already accepted on this machine'
      : 'Read every value above to the owner, the commands and the kickoff prompt in particular. Accept with: factory.mjs trust --yes, only when the owner agrees.';
    return view;
  }
  writeTrust(plan, cfg);
  return { ...view, trusted_now: true, why_not: undefined, accepted: true };
}

// ---- settings

// Every setting a person may change, with its type and what it means. `show` prints these;
// `set`, `add` and `remove` refuse a key that is not here, so a typo cannot add a dead setting.
const SETTINGS = {
  project: ['project', 'The name used in prompts, logs and run ids.'],
  main_branch: ['ref', 'The branch accepted sessions are merged to.'],
  worktree_root: ['string', 'Where session worktrees and review clones go. Keep it short.'],
  branch_prefix: ['ref', 'A session S is built on <prefix>S.'],
  tag_prefix: ['ref', 'A session S is accepted as the tag <prefix>S.'],
  plan_committed: ['boolean', 'Whether the plan folder is committed to the repository.'],
  'builder.model': ['string', 'The model the builder runs on, as `opencode models` prints it.'],
  'builder.config': ['file', 'The builder\'s rules file: which commands it is refused. Never empty.'],
  'builder.thinking': ['boolean', 'Write the builder\'s reasoning to its log as well as its actions.'],
  'commands.install': ['string', 'What a clean clone needs before anything runs.'],
  'commands.phase': ['string', 'The one command that decides a session; {session} is replaced.'],
  'commands.mutate': ['string', 'The mutation run; {session} is replaced.'],
  'stop_policy.failed_reviews': ['count', 'Failed reviews of one session before the loop waits for the owner.'],
  'stop_policy.unfinished_turns': ['count', 'Builder turns ending with no handback before the loop waits.'],
  'stop_policy.stalls': ['count', 'Stalled waits before the loop waits for the owner.'],
  'stop_policy.push_after_accept': ['boolean', 'Push the main branch and the tag after each accepted session.'],
  'limits.max_subagents': ['count', 'Helper agents that may run at once. Lower it on a small machine.'],
  'limits.parallel_sessions': ['count', 'Builder sessions at once. Keep 1 unless the machine and the plan allow more.'],
  'models.audit_reviewer': ['model', 'Model for the four audit reviewers. Empty: same as the chat.'],
  'models.finding_verifier': ['model', 'Model for the agent that tries to disprove findings.'],
  'models.plan_reviewer': ['model', 'Model for the plan reviewers. Worth the strongest model in round 1.'],
  'models.session_reviewer': ['model', 'Model for the clean-clone review of each session.'],
  'models.read_list_drafter': ['model', 'Model for drafting each session\'s reading list.'],
  owner_only: ['list', 'Actions no agent takes.'],
  builder_must_not_read: ['list', 'Paths the builder is told not to open.'],
};
const CLEARABLE = new Set(['builder.model', 'commands.install', 'commands.phase', 'commands.mutate']);

function getPath(obj, key) { return key.split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj); }
function setPath(obj, key, v) {
  const ks = key.split('.');
  let a = obj;
  for (const k of ks.slice(0, -1)) { if (typeof a[k] !== 'object' || a[k] === null) a[k] = {}; a = a[k]; }
  a[ks[ks.length - 1]] = v;
}
function knownKey(key) {
  if (!key || !SETTINGS[key]) fail(`unknown setting "${key || ''}". Known: ${Object.keys(SETTINGS).join(', ')}`);
  return SETTINGS[key];
}

// A setting may be changed only in a plan folder the owner has accepted; the change is then
// part of what is accepted. In a folder that is not accepted, a change would launder it.
function changeCfg(o, fn) {
  const plan = findPlan(o);
  const file = path.join(plan, 'factory.config.json');
  const cfg = readCfg(file);
  checkShape(cfg);
  const t = trustState(plan, cfg);
  if (!t.trusted) fail(UNTRUSTED(t.reason));
  checkRepo(cfg);
  const result = fn(cfg);
  checkShape(cfg);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  writeTrust(plan, cfg);
  return result;
}

function cmdShow(o) {
  const plan = findPlan(o);
  const file = path.join(plan, 'factory.config.json');
  const cfg = readCfg(file);
  const settings = Object.entries(SETTINGS).map(([key, [type, meaning]]) => {
    const v = getPath(cfg, key);
    return { key, value: v === undefined ? (type === 'list' ? [] : '') : v, type, meaning };
  });
  const needed = [];
  if (!cfg.builder?.model) needed.push('builder.model (before the build stage)');
  if (!cfg.commands?.phase) needed.push('commands.phase (set at the plan stage)');
  if (!cfg.commands?.install) needed.push('commands.install (if a clean clone needs one)');
  const t = trustState(plan, cfg);
  return { config: file, repo: cfg.repo, accepted_on_this_machine: t.trusted, ...(t.trusted ? {} : { why_not: t.reason }), settings, still_empty: needed };
}

function coerce(key, type, raw) {
  if (type === 'count') {
    const v = Number(raw);
    const min = key.startsWith('limits.') || key === 'stop_policy.failed_reviews' || key === 'stop_policy.unfinished_turns' || key === 'stop_policy.stalls' ? 1 : 0;
    if (!Number.isInteger(v) || v < min) fail(`"${key}" takes a whole number, ${min} or more`);
    return v;
  }
  if (type === 'boolean') {
    if (!/^(true|false|yes|no|on|off)$/i.test(raw)) fail(`"${key}" takes true or false`);
    return /^(true|yes|on)$/i.test(raw);
  }
  if (type === 'model') {
    if (!/^[A-Za-z0-9][\w.-]*$/.test(raw)) fail(`"${key}" takes one model name the Agent tool accepts (for example opus, sonnet, haiku); use unset for the chat's own model`);
    return raw;
  }
  if (type === 'project') { if (!PROJECT_RE.test(raw)) fail(`"${key}" takes letters, digits, _ and -, at most 32, starting with a letter or digit`); return raw; }
  if (type === 'ref') { if (!REF_RE.test(raw)) fail(`"${key}" holds characters that are not allowed in a branch or tag name`); return raw; }
  if (type === 'file') {
    if (!raw) fail(`"${key}" cannot be empty: a builder runs auto-approved and must have a rules file`);
    if (!fs.existsSync(raw)) fail(`file not found: ${raw}`);
    return path.resolve(raw);
  }
  if (!raw) fail(`give a value for "${key}", or use: unset ${key}`);
  if (key === 'builder.model' && !/^[A-Za-z0-9][\w.-]*\/\S+$/.test(raw)) fail('builder.model takes provider/model, as `opencode models` prints it');
  return raw;
}

function cmdSet(o) {
  const [key, ...rest] = o._;
  const [type] = knownKey(key);
  if (type === 'list') fail(`"${key}" is a list: use add or remove`);
  const v = coerce(key, type, rest.join(' ').trim());
  return changeCfg(o, (cfg) => { const before = getPath(cfg, key); setPath(cfg, key, v); return { key, before: before === undefined ? null : before, after: v }; });
}

function cmdUnset(o) {
  const [key] = o._;
  const [type] = knownKey(key);
  if (type !== 'model' && !CLEARABLE.has(key)) fail(`"${key}" cannot be cleared`);
  return changeCfg(o, (cfg) => { const before = getPath(cfg, key); setPath(cfg, key, ''); return { key, before: before === undefined ? null : before, after: '' }; });
}

function cmdList(o, add) {
  const [key, ...rest] = o._;
  const [type] = knownKey(key);
  if (type !== 'list') fail(`"${key}" is not a list: use set`);
  const item = rest.join(' ').trim() || fail(`usage: ${add ? 'add' : 'remove'} <key> <item>`);
  return changeCfg(o, (cfg) => {
    const cur = Array.isArray(cfg[key]) ? cfg[key] : [];
    const has = cur.includes(item);
    if (add && has) return { key, changed: false, items: cur };
    if (!add && !has) fail(`"${item}" is not in ${key}. Items: ${JSON.stringify(cur)}`);
    cfg[key] = add ? [...cur, item] : cur.filter((x) => x !== item);
    return { key, changed: true, items: cfg[key] };
  });
}

// ---- doctor: is this machine, and this project, ready? Spends nothing: no model is called.

function findOpencode() {
  const named = process.env.OC_BRIDGE_OPENCODE;
  if (named) return fs.existsSync(named) && !(process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(named)) ? named : null;
  const exe = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  for (const d of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const c of [path.join(d, 'node_modules', '@opencode', 'cli', 'bin', exe), path.join(d, exe)]) {
      if (fs.existsSync(c)) return c;
    }
  }
  return null;
}

function run(file, args, ms = 30000) {
  try { return { ok: true, out: execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: ms }).trim() }; }
  catch (e) { return { ok: false, out: String(e.stderr || e.message || '').trim().split(/\r?\n/)[0] }; }
}

// A deny pattern with * wildcards, matched against a whole command.
function wild(pattern) {
  return new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 's');
}

function rulesReport(file) {
  let bash;
  try { bash = JSON.parse(fs.readFileSync(file, 'utf8')).permission?.bash; } catch { return { state: 'fail', detail: 'it is not readable JSON', fix: 'restore it from the plugin\'s bridge/configs/no-deploy-no-push.json' }; }
  const extras = rulesExtras(fs.readFileSync(file, 'utf8'));
  if (extras.length) return { state: 'fail', detail: `it holds more than deny rules: ${extras.join('; ')}`, fix: 'a rules file holds "$schema" and "permission" only, and its shell rules are a first "*": "allow" followed by denies' };
  if (bash === 'deny') return { state: 'ok', detail: 'it refuses every shell command' };
  const denies = bash && typeof bash === 'object' ? Object.entries(bash).filter(([, v]) => v === 'deny').map(([k]) => wild(k)) : [];
  if (!denies.length) return { state: 'fail', detail: 'it refuses nothing', fix: 'runs are auto-approved: the rules file must deny pushes and deploys' };
  const through = RULE_SAMPLES.filter((c) => !denies.some((re) => re.test(c)));
  if (through.includes('git push origin main')) return { state: 'fail', detail: 'a plain `git push origin main` is not refused', fix: 'add a deny rule such as "*git*push*"' };
  const n = RULE_SAMPLES.length - through.length;
  const caught = RULE_HARMLESS.filter((c) => denies.some((re) => re.test(c)));
  if (through.length) return { state: 'warn', detail: `${n} of ${RULE_SAMPLES.length} sample commands refused; not refused: ${through.join(' | ')}`, fix: 'add deny rules for those, and for this project\'s own deploy command' };
  if (caught.length) return { state: 'warn', detail: `all ${RULE_SAMPLES.length} sample commands refused, but so is ordinary work: ${caught.join(' | ')}`, fix: 'narrow the rule that catches them: a builder that cannot commit or test will not finish' };
  return { state: 'ok', detail: `all ${RULE_SAMPLES.length} sample commands refused, and ${RULE_HARMLESS.length} ordinary commands left alone. This shows the plain forms are covered; it is not proof that a push or deploy is impossible.` };
}

function cmdDoctor(o) {
  const checks = [];
  const add = (name, state, detail, fix) => checks.push({ name, state, detail, ...(fix && state !== 'ok' ? { fix } : {}) });
  const build = o.stage === 'build';

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 20 ? 'ok' : 'fail', 'v' + process.versions.node, 'install Node 20 or later');
  const g = run('git', ['--version']);
  add('git', g.ok ? 'ok' : 'fail', g.ok ? g.out : 'not found', 'install git');

  const oc = findOpencode();
  let models = null;
  if (!oc) add('builder tool', 'fail', 'the opencode binary was not found', 'install OpenCode 2 or later; or set OC_BRIDGE_OPENCODE to the binary itself, not a .cmd shim');
  else {
    const v = run(oc, ['--version']);
    add('builder tool', v.ok ? 'ok' : 'fail', v.ok ? v.out.split(/\r?\n/)[0] : v.out, 'reinstall OpenCode');
    const h = run(oc, ['run', '--help']);
    const lacking = ['--auto', '--standalone', '--session'].filter((f) => !h.out.includes(f));
    add('builder tool options', h.ok && !lacking.length ? 'ok' : 'fail', h.ok ? (lacking.length ? 'this OpenCode lacks: ' + lacking.join(', ') : 'has the options the bridge uses') : h.out, 'the bridge needs OpenCode 2 or later');
    const m = run(oc, ['models'], 60000);
    models = m.ok ? m.out.split(/\r?\n/).map((x) => x.trim()).filter((x) => x.includes('/')) : null;
    if (!models) add('builder models', 'fail', 'could not list models: ' + m.out, 'run: opencode auth login');
    else add('builder models', models.length ? 'ok' : 'fail', `${models.length} listed. That a sign-in works and has quota is NOT checked here: run the one-line test in the user guide.`, 'run: opencode auth login');
  }

  const home = process.env.OC_BRIDGE_HOME || path.join(os.homedir(), '.oc-bridge');
  let probe = home;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  try { fs.accessSync(probe, fs.constants.W_OK); add('bridge records', 'ok', home); }
  catch { add('bridge records', 'fail', 'cannot write under ' + probe, 'make that folder writable, or set OC_BRIDGE_HOME'); }

  if (process.platform === 'darwin') add('free memory', 'ok', 'not measured on macOS');
  else {
    const freeGb = os.freemem() / 2 ** 30;
    add('free memory', freeGb >= 3 ? 'ok' : 'warn', freeGb.toFixed(1) + ' GB free', 'close what you do not need; a builder, a conductor and a review want about 3 GB');
  }

  let plan = null;
  try { plan = findPlan(o); } catch { /* machine checks only */ }
  if (!plan) add('project', 'warn', 'no factory-plan/ here: machine checks only', 'run init in the repository to set a project up');
  else {
    const cfg = readCfg(path.join(plan, 'factory.config.json'));
    let shapeOk = true;
    try { checkShape(cfg); } catch (e) { shapeOk = false; add('project', 'fail', e.message, 'correct factory.config.json'); }
    if (shapeOk) {
      add('project', 'ok', cfg.project + ' (' + plan + ')');
      let t = { trusted: false, reason: 'cannot read the repository' };
      try { t = trustState(plan, cfg); if (t.trusted) checkRepo(cfg); } catch (e) { t = { trusted: false, reason: e.message }; }
      add('plan folder accepted here', t.trusted ? 'ok' : 'fail', t.trusted ? 'accepted on this machine' : t.reason, 'show the owner what it holds with `factory.mjs trust`; accept with `trust --yes` only when the owner agrees');

      const model = cfg.builder?.model;
      if (!model) add('builder model', build ? 'fail' : 'warn', 'not set', 'set builder.model <id>, an id from: opencode models');
      else if (models && !models.includes(model)) add('builder model', 'fail', model + ' is not in the list opencode offers', 'pick an id from: opencode models');
      else add('builder model', models ? 'ok' : 'warn', model + (models ? '' : ' (could not verify)'));

      const rules = cfg.builder?.config;
      if (!rules || !fs.existsSync(rules)) add('builder rules file', 'fail', rules ? 'not found: ' + rules : 'not set', 'set builder.config <file>; init writes one to factory-plan/builder-rules.json');
      else { const r = rulesReport(rules); add('builder rules file', r.state, r.detail, r.fix); }

      let clean = null, baseline = null, onMain = null;
      try { clean = git(cfg.repo, ['status', '--porcelain']) === ''; } catch { /* not a repo */ }
      try { baseline = git(cfg.repo, ['tag', '-l', cfg.tag_prefix + 'baseline']) !== ''; } catch { /* not a repo */ }
      try { onMain = git(cfg.repo, ['symbolic-ref', '--short', 'HEAD']) === cfg.main_branch; } catch { /* detached */ }
      if (clean === null) add('repository', 'fail', 'cannot read ' + cfg.repo, 'check the repo path in the config');
      else {
        add('working tree', clean ? 'ok' : (build ? 'fail' : 'warn'), clean ? 'clean' : 'uncommitted changes in the main checkout', 'commit or stash them before the build stage: a review restores files, and a mistake there must not cost your work');
        add('main checkout', onMain ? 'ok' : 'warn', onMain ? 'on ' + cfg.main_branch : 'not on ' + cfg.main_branch, 'the conductor merges into ' + cfg.main_branch + ' from the main checkout');
        add('baseline tag', baseline ? 'ok' : 'fail', baseline ? cfg.tag_prefix + 'baseline' : 'missing', 'git tag ' + cfg.tag_prefix + 'baseline   (on the commit the rebuild starts from)');
      }
      const wt = cfg.worktree_root || '';
      add('worktree folder', wt.length <= 60 ? 'ok' : 'warn', wt + ' (' + wt.length + ' characters)', 'use a shorter path: deep paths break tools on Windows');
      if (!cfg.commands?.phase) add('commands.phase', build ? 'fail' : 'warn', 'not set', 'the plan stage sets it; the build stage cannot run without it');
      if (!cfg.commands?.install) add('commands.install', 'warn', 'not set', 'set it if a clean clone needs an install step');
    }
  }

  const fails = checks.filter((c) => c.state === 'fail').length;
  const warns = checks.filter((c) => c.state === 'warn').length;
  return {
    ok: fails === 0, ready: fails === 0 ? (warns ? 'ready, with warnings' : 'ready') : 'not ready', fails, warns,
    what_this_means: '"ready" means the listed checks passed. It does not mean a builder run is safe: the rules file refuses command text and is not a sandbox.',
    checks,
  };
}

const cmds = {
  init: cmdInit, doctor: cmdDoctor, trust: cmdTrust, where: cmdWhere, prompt: cmdPrompt, 'check-handback': cmdCheckHandback,
  accept: cmdAccept, seal: cmdSeal, 'check-seal': cmdCheckSeal, show: cmdShow, set: cmdSet, unset: cmdUnset,
  add: (o) => cmdList(o, true), remove: (o) => cmdList(o, false),
};
// For these, everything after the key is the value, dashes and all.
const RAW_VALUE = new Set(['set', 'add', 'remove', 'unset']);

const argv = process.argv.slice(2);
try {
  let planOpt;
  if (argv[0] === '--plan') { planOpt = argv[1]; argv.splice(0, 2); }
  const [name, ...rest] = argv;
  if (!cmds[name]) {
    console.log('usage: factory.mjs [--plan <dir>] init | doctor [--stage build] | trust [--yes] | where | prompt <session> --notes-file <f> | check-handback <session> | accept <session> | seal <session> | check-seal <session> | show | set <key> <value> | unset <key> | add <key> <item> | remove <key> <item>');
    process.exit(2);
  }
  let o;
  if (RAW_VALUE.has(name)) {
    if (rest[0] === '--plan') { planOpt = rest[1]; rest.splice(0, 2); }
    o = { _: rest };
  } else o = parseArgs(rest);
  if (planOpt && !o.plan) o.plan = planOpt;
  const out = cmds[name](o);
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok === false ? 1 : 0);
} catch (e) {
  if (e instanceof Fail) { console.error('factory: ' + e.message); process.exit(2); }
  throw e;
}

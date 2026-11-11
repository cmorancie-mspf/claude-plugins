#!/usr/bin/env node
// Repository check, run by CI and by hand: every manifest parses and names files that exist,
// every skill and agent has its frontmatter, every script parses, and nothing machine-specific
// has been committed. No dependencies.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const bad = (m) => problems.push(m);
const rel = (p) => path.relative(root, p).split(path.sep).join('/');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { bad(`${rel(p)}: not valid JSON: ${e.message}`); return null; } };

const files = walk(root);
for (const f of files.filter((x) => x.endsWith('.json'))) readJson(f);

const market = readJson(path.join(root, '.claude-plugin', 'marketplace.json'));
const plugins = [];
if (market) {
  if (!market.name) bad('marketplace.json: no name');
  for (const p of market.plugins || []) {
    const dir = path.resolve(root, p.source || '');
    const manifest = path.join(dir, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(manifest)) { bad(`marketplace.json: plugin "${p.name}" has no ${rel(manifest)}`); continue; }
    const pj = readJson(manifest);
    if (pj && pj.name !== p.name) bad(`${rel(manifest)}: name "${pj.name}" differs from the marketplace entry "${p.name}"`);
    if (pj && !/^\d+\.\d+\.\d+$/.test(pj.version || '')) bad(`${rel(manifest)}: version is not x.y.z`);
    if (!fs.existsSync(path.join(dir, 'README.md'))) bad(`${rel(dir)}: no README.md`);
    plugins.push(dir);
  }
}

const front = /^---\r?\nname: (.+)\r?\ndescription: (.+)\r?\n(?:[a-z_-]+: .+\r?\n)*---\r?\n/;
for (const dir of plugins) {
  const skills = path.join(dir, 'skills');
  if (fs.existsSync(skills)) for (const s of fs.readdirSync(skills)) {
    const f = path.join(skills, s, 'SKILL.md');
    if (!fs.existsSync(f)) { bad(`${rel(path.join(skills, s))}: no SKILL.md`); continue; }
    const m = fs.readFileSync(f, 'utf8').match(front);
    if (!m) bad(`${rel(f)}: missing name/description frontmatter`);
    else if (m[1].trim() !== s) bad(`${rel(f)}: name "${m[1].trim()}" differs from its folder`);
  }
  const agents = path.join(dir, 'agents');
  if (fs.existsSync(agents)) for (const a of fs.readdirSync(agents).filter((x) => x.endsWith('.md'))) {
    const m = fs.readFileSync(path.join(agents, a), 'utf8').match(front);
    if (!m) bad(`${rel(path.join(agents, a))}: missing name/description frontmatter`);
    else if (m[1].trim() !== a.replace(/\.md$/, '')) bad(`${rel(path.join(agents, a))}: name differs from its file`);
  }
  // Every file a skill, agent or reference points at through the plugin root must exist.
  for (const f of walk(dir).filter((x) => /\.(md|json)$/.test(x))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\$\{?CLAUDE_PLUGIN_ROOT\}?\/([A-Za-z0-9_.\/-]+)/g)) {
      const target = m[1].replace(/[.,;:]+$/, '');
      if (!fs.existsSync(path.join(dir, target))) bad(`${rel(f)}: points at ${target}, which does not exist`);
    }
  }
}

for (const f of files.filter((x) => /\.(mjs|cjs|js)$/.test(x))) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { bad(`${rel(f)}: does not parse: ${String(e.stderr || e.message).split('\n')[0]}`); }
}

// Nothing that belongs to one machine or one person.
const machine = [/\b[A-Za-z]:\\\\?(Users|MSPF)\b/, /\/Users\/[a-z]/, /\/home\/[a-z]/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(ghp|gho|github_pat|sk-ant|sk-proj|xox[baprs])[-_][A-Za-z0-9_-]{16,}/];
for (const f of files.filter((x) => /\.(md|json|mjs|cjs|js|yml|yaml|txt)$/.test(x) && !x.endsWith(path.join('.github', 'check.mjs')))) {
  const text = fs.readFileSync(f, 'utf8');
  for (const re of machine) if (re.test(text)) bad(`${rel(f)}: contains a machine path or a secret-shaped string (${re.source.slice(0, 24)}…)`);
}

if (problems.length) { console.error(problems.map((p) => 'FAIL ' + p).join('\n')); process.exit(1); }
console.log(`ok: ${plugins.length} plugin(s), ${files.length} files checked`);

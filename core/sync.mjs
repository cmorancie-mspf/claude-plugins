#!/usr/bin/env node
// Copies the shared code in core/ into each plugin that carries it, or checks that every copy
// still matches. core/ is the only place this code is edited; a plugin's copy is what gets
// installed, because a plugin is installed from its own folder.
//
//   node core/sync.mjs            copy every part into every consumer (files core lacks are removed)
//   node core/sync.mjs --check    exit 1 and name each file that differs, is missing or is extra
//   [--root <repo>]               the repository root (default: the folder above core/)
//
// core/consumers.json maps a plugin folder to the parts it carries: { "plugin": ["bridge", "lib"] }.
// Text is compared with line endings normalised, so a Windows checkout of the same file matches.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class Fail extends Error {}
const args = process.argv.slice(2);
const check = args.includes('--check');
const at = args.indexOf('--root');
const root = path.resolve(at >= 0 ? args[at + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const core = path.join(root, 'core');

const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file).toString('latin1').replace(/\r\n/g, '\n')).digest('hex');
function files(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, base, out); else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

function plan() {
  let consumers;
  try { consumers = JSON.parse(fs.readFileSync(path.join(core, 'consumers.json'), 'utf8')); }
  catch (e) { throw new Fail('core/consumers.json is missing or not JSON: ' + e.message); }
  const jobs = [];
  for (const [plugin, parts] of Object.entries(consumers)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(plugin)) throw new Fail(`"${plugin}" is not a plugin folder at the repository root`);
    if (!Array.isArray(parts) || !parts.length) throw new Fail(`consumer "${plugin}" lists no parts`);
    for (const part of parts) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(part) || part === 'tests' || !fs.existsSync(path.join(core, part))) throw new Fail(`core has no part "${part}" (named by ${plugin})`);
      jobs.push({ plugin, part, from: path.join(core, part), to: path.join(root, plugin, part) });
    }
  }
  return jobs;
}

try {
  const problems = [];
  let copied = 0;
  for (const j of plan()) {
    const want = files(j.from), have = files(j.to);
    for (const f of want) {
      const dst = path.join(j.to, f), label = `${j.plugin}/${j.part}/${f}`;
      const same = fs.existsSync(dst) && hash(dst) === hash(path.join(j.from, f));
      if (same) continue;
      if (check) problems.push(`${label}: ${fs.existsSync(dst) ? 'differs from core' : 'missing'}`);
      else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(path.join(j.from, f), dst); copied++; }
    }
    for (const f of have.filter((x) => !want.includes(x))) {
      if (check) problems.push(`${j.plugin}/${j.part}/${f}: not in core`);
      else { fs.rmSync(path.join(j.to, f)); copied++; }
    }
  }
  if (problems.length) {
    console.error(problems.map((p) => 'FAIL ' + p).join('\n') + '\nEdit core/ and run: node core/sync.mjs');
    process.exit(1);
  }
  console.log(check ? 'ok: every copy matches core/' : `ok: ${copied} file(s) copied or removed`);
} catch (e) {
  if (e instanceof Fail) { console.error('core sync: ' + e.message); process.exit(2); }
  throw e;
}

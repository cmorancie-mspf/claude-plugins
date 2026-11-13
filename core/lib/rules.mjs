// Shared checks of an OpenCode rules file (deny rules for an auto-approved worker). No dependencies.
// These match command TEXT, as OpenCode does. A different spelling, a script that runs a
// command from inside, or another tool gets through. Nothing here is a sandbox.

import fs from 'node:fs';

// A deny pattern with * wildcards, matched against a whole command.
export function wild(pattern) {
  return new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 's');
}

// What a rules file holds besides deny rules. A key other than "$schema" and "permission" is
// something OpenCode would load or run; a shell rule other than a first "*": "allow" followed by
// denies could switch a deny off while the deny is still listed.
export function rulesExtras(text) {
  let j;
  try { j = JSON.parse(text); } catch { return ['(not readable JSON)']; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return ['(not a JSON object)'];
  const out = Object.keys(j).filter((k) => k !== '$schema' && k !== 'permission');
  const bash = j.permission?.bash;
  if (bash && typeof bash === 'object') {
    Object.entries(bash).forEach(([k, v], i) => {
      if (v === 'deny') return;
      if (!(i === 0 && k === '*' && v === 'allow')) out.push(`a shell rule that is not a deny: "${k}": ${JSON.stringify(v)}${k === '*' ? ' (it must be the first entry)' : ''}`);
    });
  }
  return out;
}

// The deny patterns of a rules file, as regular expressions, or null when it refuses everything.
export function denyPatterns(text) {
  const bash = JSON.parse(text).permission?.bash;
  if (bash === 'deny') return null;
  return bash && typeof bash === 'object' ? Object.entries(bash).filter(([, v]) => v === 'deny').map(([k]) => wild(k)) : [];
}

// Try every command in mustRefuse and harmless against a rules file.
// Returns { state: ok|warn|fail, detail, through: [...], caught: [...] }.
export function sampleRules(file, mustRefuse, harmless = []) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); JSON.parse(text); }
  catch { return { state: 'fail', detail: 'the rules file is missing or not readable JSON', through: mustRefuse, caught: [] }; }
  const extras = rulesExtras(text);
  if (extras.length) return { state: 'fail', detail: 'it holds more than deny rules: ' + extras.join('; '), through: mustRefuse, caught: [] };
  const denies = denyPatterns(text);
  if (denies === null) return { state: 'ok', detail: 'it refuses every shell command', through: [], caught: harmless };
  if (!denies.length) return { state: 'fail', detail: 'it refuses nothing', through: mustRefuse, caught: [] };
  const through = mustRefuse.filter((c) => !denies.some((re) => re.test(c)));
  const caught = harmless.filter((c) => denies.some((re) => re.test(c)));
  if (through.length) return { state: 'fail', detail: `${mustRefuse.length - through.length} of ${mustRefuse.length} commands refused; NOT refused: ${through.join(' | ')}`, through, caught };
  if (caught.length) return { state: 'warn', detail: `all ${mustRefuse.length} commands refused, but so is ordinary work: ${caught.join(' | ')}`, through, caught };
  return { state: 'ok', detail: `all ${mustRefuse.length} commands refused and ${harmless.length} ordinary commands left alone. The plain forms are covered; this is not proof that another spelling is refused.`, through, caught };
}

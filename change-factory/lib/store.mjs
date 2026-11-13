// Shared helpers for records kept in the user's home folder: hashing, a lock, an append-only
// JSON-lines file. No dependencies.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
export const readOr = (file, dflt = null) => { try { return fs.readFileSync(file, 'utf8'); } catch { return dflt; } };

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Is a process alive? true, false, or null when the id is not a usable process id.
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Move a dead holder's lock out of the way. If what was moved is not that holder's lock (another
// waiter took the lock in between), put it back: only the waiter that moved the dead lock goes on.
function takeOver(lockFile, seen) {
  const grave = `${lockFile}.${process.pid}.${Date.now()}.stale`;
  try { fs.renameSync(lockFile, grave); } catch { return; }
  let moved = null;
  try { moved = fs.readFileSync(grave, 'utf8'); } catch { /* gone */ }
  if (moved !== seen) { try { fs.linkSync(grave, lockFile); } catch { /* a third one has it now */ } }
  try { fs.rmSync(grave, { force: true }); } catch { /* gone */ }
}

// Run fn while holding a lock file (created exclusively, holding the holder's process id). A lock is
// taken over only when its holder is known to be gone, or, when no holder can be read, once it is
// older than staleMs. A live holder is waited for, however long it holds. Throws when the lock
// cannot be had within waitMs.
export function withLock(lockFile, fn, { waitMs = 10_000, staleMs = 30_000 } = {}) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const until = Date.now() + waitMs;
  for (;;) {
    try { fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let seen = null, holder = null, age = 0;
      try { seen = fs.readFileSync(lockFile, 'utf8'); holder = Number(seen.trim()); age = Date.now() - fs.statSync(lockFile).mtimeMs; } catch { continue; }
      const live = pidAlive(holder);
      if (live === false || (live === null && age > staleMs)) { takeOver(lockFile, seen); continue; }
      if (Date.now() > until) throw new Error(`could not get the lock ${lockFile} within ${waitMs} ms (held by process ${holder || 'unknown'}; if no change-factory helper is running, delete the file)`);
      sleepSync(50);
    }
  }
  try { return fn(); } finally { try { fs.rmSync(lockFile); } catch { /* already gone */ } }
}

// Lines of a JSON-lines file. A line that does not parse is returned as { _bad: line, _n }.
export function readJsonl(file) {
  const text = readOr(file, '');
  return text.split('\n').filter((l) => l.trim()).map((l, i) => { try { return JSON.parse(l); } catch { return { _bad: l, _n: i + 1 }; } });
}

// Append one record to a hash-chained JSON-lines file under its lock. `make(last)` receives the
// last record (or null) and returns the new one; seq and prev are filled in here. The chain shows
// a hand edit or a lost line; it is not a signature.
export function appendChained(file, make) {
  return withLock(file + '.lock', () => {
    const text = readOr(file, '');
    const lines = text.split('\n').filter((l) => l.trim());
    const lastLine = lines.length ? lines[lines.length - 1] : null;
    let last = null;
    if (lastLine) { try { last = JSON.parse(lastLine); } catch { throw new Error(`the last line of ${file} is damaged; run verify`); } }
    const rec = make(last);
    const out = { seq: last ? last.seq + 1 : 1, ...rec, prev: lastLine ? sha(lastLine) : null };
    const line = JSON.stringify(out);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line + '\n');
    return out;
  });
}

// Walk a chained file: every line parses, seq counts up by one, prev is the hash of the line before.
export function verifyChain(file) {
  const lines = (readOr(file, '') || '').split('\n').filter((l) => l.trim());
  const problems = [];
  let prevLine = null;
  lines.forEach((l, i) => {
    let r;
    try { r = JSON.parse(l); } catch { problems.push(`line ${i + 1}: not JSON`); prevLine = l; return; }
    if (r.seq !== i + 1) problems.push(`line ${i + 1}: seq is ${r.seq}`);
    const want = prevLine === null ? null : sha(prevLine);
    if (r.prev !== want) problems.push(`line ${i + 1}: does not follow line ${i} (edited, removed or inserted)`);
    prevLine = l;
  });
  return { lines: lines.length, ok: problems.length === 0, problems };
}

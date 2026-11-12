#!/usr/bin/env node
// Starts the expertise-miner MCP server under a Python that actually works.
// `python` is missing on some machines and is a do-nothing stub on others, so each candidate
// is run once and must report version 3.9 or later. Set EXPERTISE_MINER_PYTHON to choose one.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, 'server.py');
const PROBE = 'import sys; print(sys.version_info[0] * 100 + sys.version_info[1])';

function works(cmd, args) {
  try {
    const r = spawnSync(cmd, [...args, '-c', PROBE], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    return r.status === 0 && Number(String(r.stdout).trim()) >= 309;
  } catch { return false; }
}

const chosen = (process.env.EXPERTISE_MINER_PYTHON || '').trim();
const candidates = chosen
  ? [[chosen, []]]
  : process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];

const found = candidates.find(([cmd, args]) => works(cmd, args));
if (!found) {
  console.error(chosen
    ? `expertise-miner: EXPERTISE_MINER_PYTHON (${chosen}) did not run as Python 3.9 or later.`
    : 'expertise-miner: no Python 3.9 or later was found. Install Python, or set EXPERTISE_MINER_PYTHON to its full path.');
  process.exit(1);
}

const child = spawn(found[0], [...found[1], '-u', server], { stdio: 'inherit', windowsHide: true });
child.on('error', (e) => { console.error(`expertise-miner: ${e.message}`); process.exit(1); });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));

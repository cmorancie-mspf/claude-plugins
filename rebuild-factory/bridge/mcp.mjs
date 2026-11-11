#!/usr/bin/env node
// oc-bridge MCP server (stdio, newline-delimited JSON-RPC, no dependencies).
// A thin layer over oc.mjs. Tools return at once; to be woken when a run ends,
// the caller starts the printed `wait` command as a background shell process.

import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { start, answer, status, stop, list, BridgeError } from './oc.mjs';

const CORE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'oc.mjs');
const waitCmd = (id) => `node "${CORE}" wait ${id} --stall-min 20`;
const WAIT_NOTE = 'This returns at once. To be woken when the run ends, start wait_command as a BACKGROUND shell command; it exits 0 when the run finished, 1 when it failed or was stopped, 3 when it printed nothing for 20 minutes.';

const str = (description) => ({ type: 'string', description });
const TOOLS = [
  {
    name: 'opencode_start',
    description: 'Start a non-interactive OpenCode run in a folder, as a detached process that outlives this server. ' + WAIT_NOTE,
    inputSchema: {
      type: 'object', required: ['id', 'dir'],
      properties: {
        id: str('A new run id you choose: letters, digits, _ and -. Used by every other tool.'),
        dir: str('Absolute path of the folder OpenCode works in.'),
        prompt_file: str('Absolute path of a file holding the instructions. Preferred for anything long.'),
        prompt: str('The instructions as text, when there is no file.'),
        model: str('provider/model, as `opencode models` prints it. Omit for OpenCode\'s default.'),
        config: str('Absolute path of an OpenCode config file for this run only, typically permission deny rules. The run then uses a private OpenCode server.'),
        thinking: { type: 'boolean', description: 'Also write the reasoning of the model to the log, for every turn of this run. Default false. Makes the log much longer.' },
        auto: { type: 'boolean', description: 'Auto-approve every permission OpenCode\'s config does not deny. Default true; with false a run that needs a permission will hang.' },
      },
    },
    run: (a) => withWait(start({ id: a.id, dir: a.dir, prompt: a.prompt, promptFile: a.prompt_file, model: a.model, auto: a.auto !== false, config: a.config, thinking: !!a.thinking })),
  },
  {
    name: 'opencode_answer',
    description: 'Send a follow-up message to a run that has ended, continuing the same OpenCode session with its earlier conversation. ' + WAIT_NOTE,
    inputSchema: {
      type: 'object', required: ['id'],
      properties: { id: str('The run id.'), prompt_file: str('Absolute path of a file holding the message.'), prompt: str('The message as text.') },
    },
    run: (a) => withWait(answer({ id: a.id, prompt: a.prompt, promptFile: a.prompt_file })),
  },
  {
    name: 'opencode_status',
    description: 'Status of a run: starting, running, finished, failed, stopped or died; the exit code; seconds since it last printed anything; and the end of its log.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: str('The run id.'), tail: { type: 'number', description: 'Log lines to return. Default 30.' } } },
    run: (a) => status({ id: a.id, tail: a.tail ?? 30 }),
  },
  {
    name: 'opencode_stop',
    description: 'Kill a running OpenCode run and its child processes. The session is kept and can be continued with opencode_answer.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: str('The run id.') } },
    run: (a) => stop({ id: a.id }),
  },
  {
    name: 'opencode_list',
    description: 'Every run this bridge knows, newest first.',
    inputSchema: { type: 'object', properties: {} },
    run: () => list(),
  },
];

function withWait(s) { return { ...s, wait_command: waitCmd(s.id) }; }

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

function handle(req) {
  const { id, method, params } = req;
  const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'oc-bridge', version: '0.1.0' },
        instructions: 'Drives non-interactive OpenCode runs. opencode_start and opencode_answer return at once with a wait_command; run that as a background shell command to be woken when the run ends, then read opencode_status. One run id is one OpenCode session.',
      });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(-32602, `unknown tool ${params?.name}`);
      try {
        const out = tool.run(params.arguments || {});
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        const text = e instanceof BridgeError ? e.message : String(e?.stack || e);
        return reply({ content: [{ type: 'text', text }], isError: true });
      }
    }
    default:
      if (id !== undefined) fail(-32601, `method not found: ${method}`);
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  handle(req);
});

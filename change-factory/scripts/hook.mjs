#!/usr/bin/env node
// The guard hook's entry point: runs the helper's hook command, and asks when the helper cannot even
// load (a missing or broken file beside it). Without this, Node would exit with an error before the
// helper's own error handling runs, and Claude Code treats that as no decision.
// A missing `node` or a hook timeout still fails open; nothing inside the hook can catch those.
try {
  await import('./cf.mjs');
} catch (e) {
  const reason = `change-factory: the guard could not load (${String(e?.message || e).split(/\r?\n/)[0].slice(0, 200)}), so it asks. Reinstall the plugin. Approve only if you want this command run.`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } }) + '\n');
  process.exit(0);
}

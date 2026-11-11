# oc-bridge

Lets a Claude Code session (or anything with a shell) drive non-interactive OpenCode runs: start one in a folder, be woken when it ends, read what it said, answer it in the same OpenCode session, stop it. No dependencies; Node 20 or later.

- `oc.mjs` is the core and a command line.
- `mcp.mjs` is a stdio MCP server over the same functions.

## Tools (MCP) and commands (CLI)

| MCP tool | CLI | What it does |
|---|---|---|
| `opencode_start` | `node oc.mjs start <id> --dir <folder> --prompt-file <f> [--model <provider/model>] [--no-auto]` | Starts a run as a detached process. Returns at once. |
| `opencode_answer` | `node oc.mjs answer <id> --prompt "<text>"` | Continues the same OpenCode session after the run has ended. |
| `opencode_status` | `node oc.mjs status <id> [--tail 50]` | Status, exit code, seconds since last output, end of the log. |
| `opencode_stop` | `node oc.mjs stop <id>` | Kills the run and its children. The session can still be continued. |
| `opencode_list` | `node oc.mjs list` | Every run, newest first. |
| (none) | `node oc.mjs wait <id> [--stall-min 20]` | Blocks until the run ends. Exit 0 finished, 1 failed or stopped, 3 stalled. |

## Being woken when a run ends

An MCP server cannot wake an idle Claude session. `opencode_start` and `opencode_answer` return a `wait_command`; start it as a background shell command and the session is notified when it exits.

## Things to know

- Runs are auto-approved by default (`--auto`): OpenCode does whatever its config does not deny. Put deny rules in the project's or the user's OpenCode config before running anything unattended.
- `--config <file>` (MCP: `config`) gives one run its own OpenCode config, which is how deny rules are applied without touching the global config or the project. `configs/no-deploy-no-push.json` refuses `git push` and the common commands that publish or deploy, anywhere in a command line; edit it for the project. A run with a config uses a private OpenCode server (`--standalone`), because the shared background service does not see the run's environment.
- Deny rules match the command text. They stop a model that follows the obvious path; they are not a sandbox, and a script that deploys from inside would get through.
- State and logs are under `~/.oc-bridge/runs/<id>/` (`OC_BRIDGE_HOME` overrides). Delete a run's folder to forget it.
- A run id is one OpenCode session. Reusing an id is refused; use `answer`, or a new id.
- The prompt is always passed as a file the model is told to read, so quoting and length never matter.
- OpenCode takes its working folder from the `PWD` variable when a POSIX shell set it. The bridge sets `PWD` to the run's folder; without that, a run started from Git Bash works in the caller's folder.
- A status of `died` means the process is gone without recording an exit, for example after a reboot.

## Supporting another builder tool

The rebuild-factory loop needs five operations from a bridge. A bridge for another coding agent offers the same ones:

| Operation | Must do |
|---|---|
| start | Begin a run in a folder from a prompt file, detached, and return at once |
| answer | Send a follow-up into the same conversation after a run has ended |
| status | Report running, finished, failed, stopped or died, with the exit code and the end of the log |
| stop | Kill a run and its child processes, keeping the conversation |
| wait | A command that blocks until the run ends, so the caller is woken |

It also needs a way to refuse commands under auto-approval.

## Register with Claude Code

Inside the rebuild-factory plugin this server is registered by the plugin's `.mcp.json`. To use the bridge alone:

    claude mcp add --scope user oc-bridge -- node "<path to this folder>/mcp.mjs"

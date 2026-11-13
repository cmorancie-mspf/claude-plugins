# oc-bridge

Lets a Claude Code session (or anything with a shell) drive non-interactive OpenCode runs: start one in a folder, be woken when it ends, read what it said, answer it in the same OpenCode session, stop it. No dependencies; Node 20 or later; OpenCode 2 or later.

- `oc.mjs` is the core and a command line.
- `mcp.mjs` is a stdio MCP server over the same functions.

## Read this first

A run is **auto-approved** by default: OpenCode does whatever its rules do not deny, and nobody sees each command. So:

- **A rules file is required.** `start` refuses an auto-approved run without `--config <file>`, and refuses a rules file that denies no shell command. To run with nothing refused you must say so explicitly (`--no-rules`).
- **A folder with its own OpenCode config is refused.** An `opencode.json` or `.opencode` in the run folder (or above it, up to the top of its git checkout) can define agents and permissions that override the rules. `start` refuses such a folder, and so does every later turn, unless `--allow-project-config` was given after reading that config.
- **The rules match command text. They are not a sandbox.** `configs/no-deploy-no-push.json` refuses the plain forms of `git push` and of common publish and deploy commands. A different spelling, a script that deploys from inside, or another tool gets through. Edit a copy of it for your project.
- **The control that holds is where the run happens:** no production credentials in reach, and a remote the run's credentials cannot write to.

## Tools (MCP) and commands (CLI)

| MCP tool | CLI | What it does |
|---|---|---|
| `opencode_start` | `node oc.mjs start <id> --dir <folder> --prompt-file <f> --config <rules> [--model <provider/model>] [--thinking] [--no-auto] [--no-rules] [--max-concurrent <n>] [--scrub-env NAME,PREFIX_*]` | Starts a run as a detached process. Returns at once. |
| `opencode_answer` | `node oc.mjs answer <id> --prompt "<text>"` | Continues the same OpenCode session after the run has ended. |
| `opencode_status` | `node oc.mjs status <id> [--tail 50]` | Status, exit code, how it ended (`end_kind`), seconds since last output, whether the rules file changed, end of the log. |
| `opencode_stop` | `node oc.mjs stop <id>` | Stops the run. The session can still be continued. |
| `opencode_list` | `node oc.mjs list` | Every run, newest first. |
| (none) | `node oc.mjs wait <id> [--stall-min 20]` | Blocks until the run ends. Exit 0 finished, 1 failed or stopped, 3 nothing printed for the stall time. |

## Being woken when a run ends

An MCP server cannot wake an idle Claude session. `opencode_start` and `opencode_answer` return a `wait_command`; start it as a background shell command and the session is notified when it exits. Exit 3 means the log was silent for the stall time, which a long quiet command also causes: read the status before deciding the run stalled.

## How the rules reach OpenCode

- The rules file is read once, when the run starts. A copy is kept with the run, with its hash, and every turn uses that copy. `answer` refuses to continue if the copy has changed; `status` says whether the original changed.
- The rules are passed as `OPENCODE_CONFIG_CONTENT`. OpenCode ranks that above a project's own `opencode.json`. Passing a file with `OPENCODE_CONFIG` would not do: a config file in the project outranks it, and could switch the rules off. Both were measured on OpenCode 2.1.4.
- The same rules are set again for each built-in agent (`build`, `plan`, `general`, `explore`), and the default agent is fixed to `build`: an agent's own permission block outranks the top-level one. An agent a project defines for itself is not covered, which is why a project config is refused.
- The rules match text, so they also refuse some harmless commands that contain the words of a refused one.
- A rules file has one shape: `"$schema"` and `"permission"` at the top, and under `permission.bash` an optional first `"*": "allow"` followed by denies only. Anything else is refused: another top-level key is something OpenCode would load or run, and an allow placed later, or a narrower allow, could switch a deny off while the deny is still listed.
- A run with rules uses a private OpenCode server (`--standalone`), because the shared background service does not see the run's environment.

## Provider cap, how a run ended, and the environment

- **Provider cap.** With `max_concurrent` (and a model), `start` counts the live runs of the same provider (the part of the model before the `/`) in the shared store, whichever program started them, and refuses when the cap is reached. The count and the new record are made under one lock, so two starts at once cannot both get in. Without `max_concurrent` there is no cap.
- **How a run ended.** When a turn exits non-zero, `end_kind` is `rate_limited`, `auth`, `quota` or `other`, read from the last 15 lines the run printed (the bridge's own lines left out). That is a heuristic over text: a run whose own last lines mention a 429 for another reason is misread, and a provider that words its errors differently comes out as `other`. Exit 0 is always `ok`; a stopped run is `stopped`, a vanished one `died`.
- **Environment scrub.** `scrub_env` drops variables from the run's environment, by name or `PREFIX_*`, matched without case, for every turn of the run. It removes variables only: credential files in the home folder stay readable.
- Run records are `"format": 2`. A record without `format` was written by an earlier bridge and is read the same way.

## Things to know

- State and logs are under `~/.oc-bridge/runs/<id>/` (`OC_BRIDGE_HOME` overrides). The log holds everything the run printed, and its reasoning if `--thinking` is on; it is kept until you delete the folder.
- A run id is one OpenCode session. Reusing an id is refused; use `answer`, or a new id.
- The prompt is always passed as a file the model is told to read, so quoting and length never matter.
- The run inherits the environment of whatever started it. Do not start one from a shell that holds production secrets.
- OpenCode takes its working folder from the `PWD` variable when a POSIX shell set it. The bridge sets `PWD` to the run's folder; without that, a run started from Git Bash works in the caller's folder.
- A status of `died` means the process is gone without recording an exit, for example after a reboot. A run recorded before the machine last booted is always reported as died.
- `stop` kills a process only when its command line names the run (the session id, or the runner's `_run <id>`). A stale record whose process id now belongs to something else is left alone. On Windows the run's child processes go with it; elsewhere its process group.
- `OC_BRIDGE_OPENCODE` names the OpenCode binary when it is not found on the path. On Windows give the `.exe`, not the `.cmd` shim.
- Text in a run's log was written by the run. Whoever reads it should treat it as data, not instructions.

## Supporting another builder tool

A conductor loop needs five operations from a bridge. A bridge for another coding agent offers the same ones:

| Operation | Must do |
|---|---|
| start | Begin a run in a folder from a prompt file, detached, and return at once. Refuse to run auto-approved without rules. |
| answer | Send a follow-up into the same conversation after a run has ended, under the rules it started with |
| status | Report running, finished, failed, stopped or died, with the exit code and the end of the log |
| stop | End a run and what it started, keeping the conversation, and never a process it cannot show to be its own |
| wait | A command that blocks until the run ends, so the caller is woken |

## Register with Claude Code

Inside a plugin that carries it, this server is registered by the plugin's `.mcp.json`; a plugin may set `OC_BRIDGE_TOOLS` there to offer only some tools (for example `status,stop,list` when its own helper starts the runs). To use the bridge alone:

    claude mcp add --scope user oc-bridge -- node "<path to this folder>/mcp.mjs"

# change-factory

**Not listed yet.** This plugin is not in the marketplace until its release review is approved (and, if the
owner holds it for one, a second real run). Try it with `claude --plugin-dir` (see Start).

Run a list of changes to a working system as parallel workstreams. The owner's list becomes numbered items and
decisions; items become streams with briefs; cheap coding workers build each stream in rounds; every round is
reviewed by another model; streams merge onto one integration branch as each goes green; every risky stream
gets one red team on the merged code; and the release asks the owner for each deploy, the move of main and the
push, one at a time.

It is for a system that works and has users, where a change that is wrong costs something.

> **Read this first.** The pipeline runs where production credentials may be in reach. Workers run
> auto-approved: their rules file refuses the plain forms of pushes, deploys, the helper's own commands and the
> configured deploy and test commands, by matching command text. A different spelling, or a script that deploys
> from inside, gets through. It is not a sandbox. Where you can, run workers where there are no production
> credentials. `worker_env_scrub` removes environment variables only; credential files in the home folder stay
> readable.

## How it works

- **The helper** (`scripts/cf.mjs`) is the only writer of the run's event log, in your home folder
  (`~/.change-factory`), never in the repository. It stamps every event itself. It starts the workers and the
  tests itself and reads their results; the conductor (the Claude Code chat) never types a result the helper
  can read. It refuses any step whose gate is not met.
- **Workers** are OpenCode runs started by the helper through the bundled bridge, with the trusted rules, a
  per-provider cap and the environment scrub. The plugin's bridge server offers status, stop and list only.
- **Reviewers, red teams, brief writers and the research analyst** are subagents with no shell.
- **The guard hook** puts every configured deploy, every push, every move of the main branch and every owner
  record in front of the person at the keyboard.

See `references/method.md` for the states, the definitions and what v1 is not.

## Skills

| Skill | What it does |
|---|---|
| `/change-factory` | Set a project up, trust its config, resume a run after a restart or a compacted chat, change settings |
| `/change-intake` | The owner's list -> items -> decisions -> streams (tier and ship mode confirmed) -> briefs, read by the conductor |
| `/change-run` | The loop: workers, reviews, escalation, tests, merges, regenerate, combined test, stream red teams, fixes |
| `/change-release` | One deploy ask per unit, rollback first; the deploy record; main and the push; carry items |
| `/change-status` | The status table from the event log |

Agents: `brief-writer`, `round-reviewer`, `stream-red-team`, `research-analyst` (all Read, Grep, Glob, Write).

## Requirements

- Node 20 or later; git 2.38 or later (conflicts are found with `git merge-tree --write-tree`).
- OpenCode 2 or later, with a model your workers can use.
- Claude Code with this plugin enabled in the session that conducts (the guard hook comes with the plugin).
- One repository per run. A change to two repositories (for example a service and a client in another
  repository) is two runs.

## Start

Try it without installing:

    claude --plugin-dir <path to this folder>

In a chat opened on (or above) the repository, type `/change-factory`. It copies
`examples/change-factory.config.json` to the repository root and fills it in with you, writes the worker rules
(`init`), checks the machine (`doctor`, free) and shows you every command the config would run (`trust`).
Accept with `trust --yes`. `hook_mode` is `"deny"` by default (a config without the key is deny; the example
config sets it too), so you run that command (and every other owner record) in your own terminal, where the
helper asks you to type `yes`; only with `"hook_mode": "ask"` set does the hook ask you in the chat instead
(see below before you switch). Then `/change-intake` with your list.

## What it costs, honestly

The plugin itself has driven no real run yet. The method was run once by hand before it was built.

- Every worker round is an OpenCode run on your provider. Rounds that fail review are paid again.
- Every round review is a subagent call on the reviewer's model; every eligible stream gets one red team on
  the strongest model you configure (a stale verdict, a paid owed pass or a stand-in adds a pass; all count
  in `max_red_team_passes`).
- Tests: local by default (on your machine, in the stream's worktree); with `tests.mode` `ci`, each test run
  is a run of your CI command.
- A resume after an account switch sends one line to each role's model (the canary).
- Budgets (`max_worker_runs`, `max_rounds_per_stream`, `max_ci_runs`, `max_red_team_passes`) are counted by the
  helper at dispatch; the run stops for the owner when one is used up. The owner changes a budget of the open
  run with `owner budget <key> <n> --why <reason>` (an owner record); a config edit applies from the next run.

## What protects what

"Refused by code" means the helper, the bridge, an agent's tool list or the guard hook says no. "Detected after"
means something reports it once it happened. "Instructed only" means a model is told, and nothing checks.

| Risk | Refused by code | Detected after | Instructed only |
|---|---|---|---|
| A worker pushes or deploys | The rules file, passed by the bridge so a project's OpenCode config cannot override it. The helper refuses to start a worker unless the rules refuse every configured deploy, the push, the paid test command, the research runner, the helper and its home folder (sampled as text) | — | Text matching: another spelling or a script gets through. The rules cover the worker's shell only: its own file tools (write, edit) are not limited by them and can reach the helper's home folder and the config. Not a sandbox |
| A worker started some other way, without rules | The bridge refuses an auto-approved start without rules; the plugin's bridge server has no start tool | `result` will not count a run whose bridge record lacks the trusted rules hash | Another bridge installed on the machine can still start a run; it is not counted |
| Too many workers on one provider | The bridge refuses a start over the provider cap, counted over the shared run store under a lock; the helper refuses on its own log as well | — | — |
| A rate-limit death counted as a failed round | A round needs new commits on the branch, read from git | The bridge classifies how a failed run ended from its last 15 lines: rate_limited, quota, auth or other. A heuristic over text, tested on fixed lines | — |
| A deploy, a push or a move of main without the owner | The guard hook refuses and gives the owner the exact command to type with `!` (`hook_mode` deny, the default), or asks the person (`hook_mode: "ask"`, only when set): each configured deploy command, the plain forms of `git push` (also `git.exe` and a quoted `"git"`), `merge --ff-only`, `branch -f`/`update-ref` of main, `fetch`/`pull` into main with a `:main` refspec, and history-changing git (`merge`, `pull`, `reset`, `rebase`, `cherry-pick`, `revert`, `commit`, `am`) whose folder git reports as the main checkout or a worktree with main checked out. The folder is the command's `-C` target, else the folder of a `cd` before it, else the chat's. It matches the Bash and PowerShell tools against a snapshot of the trusted config kept in the home folder, so editing the project's config does not blind it. Deploys and pushes are matched when the chat is opened above the repository, in it, or in a worktree under the configured worktree folder, or when the command names one of those folders (a worktree elsewhere, named by no path in the command, is not covered). Its own error asks, and so does a helper that cannot load | — | It matches text: a script that deploys or moves main from inside gets through, and so does a path spelled another way (for example `/c/...` for `C:\...`). A missing `node` or a hook timeout fails open; that cannot be caught. The person's prompt in auto mode has not yet been seen (see below) |
| An owner record made by the conductor or another session (anything with a shell can write the token file: its name is a plain hash of the command) | `hook_mode` ask (only when set): the helper refuses an owner record (`owner ...`, `trust --yes`, `run open`, a red team's model) without a one-time token the hook writes when it puts exactly that command in front of the person; every guarded tool call first removes tokens more than 3 seconds old, so a declined prompt's token is gone at the model's next guarded shell or file call. A token is good for at most 15 minutes. `hook_mode` deny (the default, also when the key is missing): the hook writes no token, and the helper accepts an owner record only from a terminal, where it shows the record and the owner types `yes`; a chat's shell and a command typed with `!` have no terminal | — | In ask mode, a script that writes the token file itself gets through. A declined prompt's token stays usable until the next guarded tool call, at most 15 minutes: anything that does not pass the hook (a process already running, a session without the plugin, a terminal) can use it in that time. In deny mode, a pseudo-terminal wrapper fed `yes` looks like a terminal. A shell command that names the home folder asks (plain forms only); an edit with Write or Edit is refused |
| The run records are edited | The hook refuses Write and Edit into the home folder, and asks for a shell command that names the home folder | Every command that reads a run re-walks the hash chain first and refuses while it is broken: a hand edit or a lost line stops the run. `verify` shows where. It is not a signature | A shell command that does not name the folder in plain text (a script, another spelling) can still rewrite them, and a rewrite of the whole chain is not seen |
| The config or the rules are changed to run something else | Any change makes the config untrusted: the helper refuses until the owner accepts again. An edit of a trusted config or rules file asks the owner | — | — |
| A stale premise | `brief record` refuses a brief without a Premise status and a file:line; `changed` stops the stream for the owner | — | That the premise was really re-read |
| A brief writer's decision nobody saw | A decision not marked "changes what is built: no", and any question, stops the stream until the owner's answer is recorded; recording the brief again cannot clear it | — | That decisions are marked honestly |
| A model reviews its own code | Dispatch refuses a reviewer on the author's model (the conductor's model for its own commits), a red team on any author's or reviewer's model (and on the conductor's when the merge holds a conflict resolution), except as a recorded owed pass. A head is reviewed once (again only to pay an owed pass), and a result file must be the one the dispatch named with `--expect` | — | That the subagent really ran on the dispatched model and wrote the file: the helper cannot see either |
| An owed strong-model pass is forgotten | `release-check` refuses a stream that ships ON with an owed pass unless the owner waived it; switch-on likewise | `status` lists owed passes | — |
| Reviewers run code, or heavy work runs on the owner's machine | Review, red-team, brief and research agents have no shell | — | The escalation worker is a subagent with a shell and no deny rules: only the hook stands there |
| A test result made up | The helper runs the test command itself, on the exact commit, and reads the exit code or the report file; results cannot be typed | — | — |
| A result for the wrong code, or tests of unread code | Tests and merges accept results only for the exact code head; a stream's test dispatch is refused unless that code head was reviewed MERGEABLE, and the combined test unless every fix and test-only commit on the integration branch was. Committing a review file does not move the code head | `reconcile` lists merges the log does not have | — |
| Generated files stale after a merge | The combined test is refused unless `regenerate` ran clean at the current code head | — | — |
| Conductor commits slip in unread | The combined test and the release refuse an integration commit that is not a recorded merge, a recorded generated commit (generated paths only), a test-only commit (test paths only, reviewed by another model), a reviewed fix, or record files only. `merge record` refuses a merge commit that differs from what git alone makes of its two parents anywhere but in the files git could not merge and in generated paths | — | That a conflict resolution is right |
| A conflict resolution unreviewed | git finds the conflict, not the conductor; a conflict outside generated paths makes the stream red-team eligible, and release refuses until it is cleared | — | That the resolution is right |
| A bug between streams, seen only on the merged branch | Release refuses a stream that ships ON (switch-on, one that ships OFF) without a cleared red team on its merge; a later merge touching its files makes the verdict stale | — | — |
| A worker outside its lane, or line endings rewritten | — | `lane`, and `merge record` itself, flag it and make the stream red-team eligible | The brief's rules |
| Main moved under the run | `finish-check` refuses unless main still equals the run's base and every code unit is recorded ok (or the owner moves main without it) | — | — |
| Credentials in the worker's environment | `worker_env_scrub` drops matching variables from workers and local test runs | — | Credential files stay readable |
| Two conductors on one run, or two commands at once | Every write needs the current lease; a takeover is recorded. Every command holds the project's lock from its first read to its last write, so two at once cannot both pass a gate or take the same id | — | A lease stops accidents, not a determined session: any session can pass the id |
| Waits that never wake the chat | A test wait ends (exit 2) when the test runner's process is gone; that run is recorded as failed | — | Background shell commands only (the run skill) |
| Stray runs after a wave | — | `strays` lists bridge runs with no open dispatch (bridge runs only; a subagent's own shells are not visible) | Stop them after each wave |

### What the hook was measured to do

A spike on Claude Code 2.1.214 ran a hook that answered `ask` for one marked command, with an allow rule for
that command present, under `claude -p` in the manual, acceptEdits, auto, bypassPermissions and dontAsk modes.
In every one the command did not run; a control without the marker ran. Under `-p` nobody is there to answer,
so an `ask` becomes a refusal, and in the "auto" run the hook reported the mode as `default`: auto mode was not
in effect. **Not yet measured:** that in an interactive session in auto mode the person is actually shown the
prompt, and that "yes" runs the command. Until the owner has checked that, `"hook_mode": "deny"` is the
default: a config without the key is deny, the example config sets it, and `ask` applies only when a config
sets it. In deny mode the hook refuses deploys, pushes, moves of main and owner
records, and prints the exact command. The owner types a deploy, the move of main or the push with `!`; an owner
record he runs in his own terminal, where the helper asks him to type `yes` (a refusal in deny mode unlocks
nothing).

The deny-mode owner path was checked by hand on Windows 11 (Node 22): `trust --yes` in Windows PowerShell and
`run open` in Git Bash (MINGW64, Git for Windows 2.55.0.windows.5; the result may differ on older Git for Windows consoles) each showed the record, asked for `yes`, recorded it after `yes`, and refused it ("not recorded") after any other answer. The same
commands from a chat's shell were refused as having no terminal. Other terminals (macOS, Linux, Windows Terminal
profiles other than these) have not been tried.

None of this replaces running workers where there is nothing to damage.

## Tests

`node tests/test_cf.mjs` (the helper, the gates, the hook) and, from the repository root,
`node core/tests/test_core.mjs` (the shared bridge: cap, end classification, environment scrub). They use a
stand-in for OpenCode and for the test command, call no model and spend nothing.

## Shared code

`bridge/` and `lib/` are copies of the repository's `core/`, made by `node core/sync.mjs`; the repository check
fails if a copy differs. Edit `core/`, never the copy.

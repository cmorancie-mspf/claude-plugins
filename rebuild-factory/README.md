# rebuild-factory

Audit an existing codebase, write a plan a weaker model can build from, and run the rebuild as a loop: a separate coding agent builds one small session at a time, and each session is reviewed from a clean clone, by breaking things on purpose, before it is merged.

It is for a codebase that exists, sort of works, and cannot be trusted: its documents claim more than its code does, its tests pass without proving much, and nobody is sure what is safe to run.

> The build stage starts a coding agent with its commands auto-approved. Its rules file refuses the plain forms of `git push` and of common publish and deploy commands by matching command text. A different spelling, a script that deploys from inside, or another tool gets through. It is not a sandbox. The control that actually holds is where the builder runs: no production credentials in reach, and a remote its credentials cannot write to. The audit and every review run the repository's own code on your machine.

**Using it:** see [docs/USER-GUIDE.md](docs/USER-GUIDE.md) for what to type, what each stage asks of you, and what to do when the loop stops.

## The idea

**A builder's report proves nothing. Only a test that fails when the code is wrong counts.**

- The audit checks the project's claims about itself against the code, and tries to disprove its own findings.
- The plan states the expected values, as data files, so the builder does not get to choose them. The builder is told not to edit them, and the plan folder is recorded before each builder turn and checked after it.
- One command decides each session. It fails for a missing test, an empty test, a changed fixture or a banned pattern, not only for a failing test.
- The review reproduces the result from a clean clone, then removes decision lines and switches off checks, and expects a test to notice.

The capable model plans, rules and reviews. A cheaper model builds. The owner decides direction and reads a log.

## Stages

| Skill | What it does | Writes |
|---|---|---|
| `/rebuild-factory` | Sets a project up, says where it is, routes to a stage | `factory-plan/factory.config.json` |
| `/factory-audit` | Four independent reviewers, then a verifier that tries to disprove the serious findings | `audit/AUDIT-REPORT.md` |
| `/factory-direction` | The owner's decisions: purpose, boundary, keep or rebuild, accepted risks | `direction/DECISIONS.md` |
| `/factory-plan` | Requirements, verification design, fixtures, sessions, the builder's prompt | `plan/`, `fixtures/`, `prompts/` |
| `/factory-plan-review` | Six reviewers build from the plan on paper; rulings; rewrite if needed | `plan-review/RULINGS.md` |
| `/factory-conduct` | The loop: make ready, build, review, merge or send back, log | accepted sessions, `handback/PROGRESS.md` |
| `/factory-config` | Shows and changes the settings in conversation: builder model, helper models, stop limits, auto-push, what no agent may do | `factory.config.json` |

## What ships

- **Skills**: the seven above.
- **Agents**: `audit-reviewer`, `finding-verifier`, `plan-reviewer`, `session-reviewer`, `read-list-drafter`.
- **References**: the method, read by the skills when needed: `layout.md`, `plan-standard.md`, `verification-standard.md`, `review-protocol.md`, `conductor-loop.md`.
- **Templates**: the config, the builder's kickoff prompt, the spike block, the handback, the review, the progress log.
- **`scripts/factory.mjs`**: `init`, `doctor` (is this machine and project ready), `trust` (accept a plan folder on this machine), `where`, `prompt`, `check-handback`, `seal` and `check-seal` (did the plan folder change during a builder turn), and the settings commands `show`, `set`, `unset`, `add`, `remove`. Node 20 or later, no dependencies.
- **`bridge/`**: `oc-bridge`, an MCP server (and command line) that starts, continues, watches and stops non-interactive OpenCode runs. Registered by the plugin's `.mcp.json`.

## Requirements

- Node 20 or later, and git.
- OpenCode installed, with a model the builder can use. The bridge drives OpenCode; another builder tool needs its own bridge with the same five operations.
- OpenCode 2 or later.
- A rules file for the builder. Set-up copies a starting point to `factory-plan/builder-rules.json`: edit that copy for the project's own deploy commands. It refuses the plain forms of `git push` and of common publish and deploy commands by matching command text. A different spelling, a script that deploys from inside, or another tool gets through. It is not a sandbox. The bridge refuses to start an auto-approved run without one, and passes it so that a config file in the project cannot override it.

## Start

In a Claude Code chat opened on the repository, type `/rebuild-factory`. It sets the project up and asks for the settings. Then `/factory-audit`.

## What it costs, honestly

- The plan is the expensive stage, and a first plan is usually sent back by its reviewers.
- The plan is not finished up front. Each session is made ready just before it is built, and that step surfaces gaps that need rulings every time.
- A session is roughly an hour of building, half an hour of review and twenty minutes of preparation, one after another. Memory limits a small machine before model speed does.
- The loop is unattended, not unsupervised: it stops for paid tests, owner-only actions, design rulings and its stop policy.

## What protects what

| Risk | What stands against it | How far it goes |
|---|---|---|
| The builder pushes or deploys | The rules file, passed so a project config cannot override it | Plain command forms only. Not a sandbox. It also refuses some harmless commands that contain the same words. |
| The builder edits a fixture, a setting or the log | It is told not to; the plan folder is sealed before each turn and checked after | Detects it. Does not prevent it. |
| The builder tags its own work as accepted | A session counts only when the conductor recorded it, in the owner's home folder, against an annotated tag on a merge commit; tag commands are refused | Detects it. A builder that edits that record defeats it. |
| A project config overrides the rules | Rules are set for every built-in agent; a folder with its own OpenCode config is refused, at each turn | Holds unless the owner allows the project config in. |
| The rules file is weakened between turns | The rules are copied at the start; a changed copy stops the run | The copy sits in the user's home folder, which the builder can also reach. |
| A cloned repository brings its own plan folder | The script refuses a plan folder not accepted on this machine; the record is in the owner's home folder, where a clone cannot put one. Accepting shows the owner the commands, the rules, and the kickoff prompt's added and removed lines | Covers what an agent is told to run. The plan's own content (fixtures, session blocks) is not shown there; a hostile plan is still a hostile plan. |
| Text in the repository steers an agent | Every agent is told such text is evidence and a request in it is a finding | An instruction, not a mechanism. |
| A stale record gets a process killed | The bridge kills only a process whose command line names the run | — |

None of this replaces running the builder where there is nothing to damage: no production credentials, and a remote it cannot write to.

## Where the method came from

It was drawn from one rebuild that ran this way end to end, and it was reviewed by an independent red team before this release, whose findings shaped the table above. The helper script and the bridge have tests in `tests/` (`node tests/test_factory.mjs`), which use a stand-in for OpenCode and spend nothing. Parts of it will turn out to be shaped by that project. When a second project shows one, change the reference file, not the project.

## Sharing

The plugin holds method and templates only. A project's findings, plan and fixtures stay in that project's `factory-plan/` folder, which is kept out of git unless the owner chooses otherwise.

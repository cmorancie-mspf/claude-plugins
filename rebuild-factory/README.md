# rebuild-factory

Audit an existing codebase, write a plan a weaker model can build from, and run the rebuild as a loop: a separate coding agent builds one small session at a time, and each session is reviewed from a clean clone, by breaking things on purpose, before it is merged.

It is for a codebase that exists, sort of works, and cannot be trusted: its documents claim more than its code does, its tests pass without proving much, and nobody is sure what is safe to run.

> The build stage starts a coding agent with its commands auto-approved. The rules file that refuses pushes and deploys matches command text and is not a sandbox. Edit it for your project, and run the loop only where an unattended coding agent is acceptable.

**Using it:** see [docs/USER-GUIDE.md](docs/USER-GUIDE.md) for what to type, what each stage asks of you, and what to do when the loop stops.

## The idea

**A builder's report proves nothing. Only a test that fails when the code is wrong counts.**

- The audit checks the project's claims about itself against the code, and tries to disprove its own findings.
- The plan owns the expected values, as data files, so a builder cannot make them agree with its code.
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
- **`scripts/factory.mjs`**: `init`, `where`, `prompt`, `check-handback`, and the settings commands `show`, `set`, `add`, `remove`. Node 20 or later, no dependencies.
- **`bridge/`**: `oc-bridge`, an MCP server (and command line) that starts, continues, watches and stops non-interactive OpenCode runs. Registered by the plugin's `.mcp.json`.

## Requirements

- Node 20 or later, and git.
- OpenCode installed, with a model the builder can use. The bridge drives OpenCode; another builder tool needs its own bridge with the same five operations.
- A deny-rules config for the builder. `bridge/configs/no-deploy-no-push.json` is a starting point: edit it for the project's own deploy commands. It matches command text and is not a sandbox.

## Start

In a Claude Code chat opened on the repository, type `/rebuild-factory`. It sets the project up and asks for the settings. Then `/factory-audit`.

## What it costs, honestly

- The plan is the expensive stage, and a first plan is usually sent back by its reviewers.
- The plan is not finished up front. Each session is made ready just before it is built, and that step surfaces gaps that need rulings every time.
- A session is roughly an hour of building, half an hour of review and twenty minutes of preparation, one after another. Memory limits a small machine before model speed does.
- The loop is unattended, not unsupervised: it stops for paid tests, owner-only actions, design rulings and its stop policy.

## Where the method came from

It was drawn from one rebuild that ran this way end to end. Parts of it will turn out to be shaped by that project. When a second project shows one, change the reference file, not the project.

## Sharing

The plugin holds method and templates only. A project's findings, plan and fixtures stay in that project's `factory-plan/` folder, which is kept out of git unless the owner chooses otherwise.

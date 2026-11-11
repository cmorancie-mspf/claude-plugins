# rebuild-factory

A Claude Code plugin for a codebase that exists, mostly works, and that you do not trust. It audits the code, writes a plan a cheaper model can build from, and runs the rebuild as a loop: a separate coding agent builds one small session at a time, and each session is reproduced from a clean clone and attacked before it is merged.

The rule behind it: **a builder's report proves nothing; only a test that fails when the code is wrong counts.**

> **Read this before you run it.**
>
> - The build stage starts a coding agent (OpenCode) with its commands **auto-approved**. Nobody watches each command.
> - The plugin ships a rules file that refuses pushes and common deploy commands. It matches command text. **It is not a sandbox.** Edit it for your project's own deploy commands before the first session.
> - Run it on a machine and a repository where an unattended coding agent is acceptable, with no production credentials in reach.
> - **Status: early.** The method comes from one rebuild that ran this way from audit to build. The helper script and the bridge are tested. The skills and agents have not yet been run on a second codebase.

## Install

```
claude plugin marketplace add <owner>/<repo>
claude plugin install rebuild-factory@mspf-factory
```

Replace `<owner>/<repo>` with this repository's address on GitHub. From a local copy, give the folder's path instead.

Then open a new Claude Code chat, type `/mcp`, and check that `oc-bridge` is listed.

## Use

In a chat opened on the repository you want rebuilt:

| # | Type | What happens |
|---|---|---|
| 1 | `/rebuild-factory` | Sets the project up and asks for a few settings |
| 2 | `/factory-audit` | Four independent reviewers audit; a fifth tries to disprove the serious findings |
| 3 | `/factory-direction` | You decide what the system is for and what is kept |
| 4 | `/factory-plan` | Writes the plan: requirements, tests, expected values, small sessions |
| 5 | `/factory-plan-review` | Six reviewers try to build from the plan on paper |
| 6 | `/factory-conduct` | The build loop, session after session, in a fresh chat |

`/factory-config` shows and changes the settings at any time. `/rebuild-factory` tells you which stage you are at if you lose your place.

Stages 1 to 5 change nothing in your code; they write documents into a `factory-plan/` folder that is kept out of git. Only stage 6 results in code changes, and each one is merged only after its review passes.

**Full guide:** [rebuild-factory/docs/USER-GUIDE.md](rebuild-factory/docs/USER-GUIDE.md)

## Requirements

- Claude Code
- Node 20 or later, and git
- For stage 6: [OpenCode](https://opencode.ai), signed in to a provider, with a model for the builder

## What is in the repository

```
.claude-plugin/marketplace.json   the marketplace entry
rebuild-factory/                  the plugin
  skills/                         the seven commands
  agents/                         five helper agents (reviewers, verifier, drafter)
  references/                     the method: plan standard, verification standard,
                                  review protocol, conductor loop, folder layout
  templates/                      config, builder prompt, handback, review, progress log
  scripts/factory.mjs             set-up, "where am I", prompt filling, settings
  bridge/                         oc-bridge: an MCP server that drives OpenCode runs
  docs/USER-GUIDE.md              the guide for owners
```

## The bridge, and other builder tools

`oc-bridge` starts, continues, watches and stops non-interactive OpenCode runs. It can be used without the rest of the plugin: see [rebuild-factory/bridge/README.md](rebuild-factory/bridge/README.md).

The loop needs only five operations from a bridge, so another coding agent can be supported by a second bridge that offers the same ones:

| Operation | Must do |
|---|---|
| start | Begin a run in a folder from a prompt file, detached, and return at once |
| answer | Send a follow-up into the same conversation after a run has ended |
| status | Report running, finished, failed, stopped or died, with the exit code and the end of the log |
| stop | Kill a run and its child processes, keeping the conversation |
| wait | A command that blocks until the run ends, so the caller is woken |

It also needs a way to refuse commands (the deny rules) under auto-approval. Contributions of bridges for other tools are welcome.

## Contributing

Where a project shows that part of the method was shaped by the one rebuild it came from, the fix belongs in `rebuild-factory/references/`, not in a project's own plan. Reports of what did not work on your codebase are the most useful contribution at this stage.

Never put a real project's findings, plan or fixtures into this repository.

## Licence

MIT. See [LICENSE](LICENSE).

# Claude Code plugins

Plugins for engineering work done as planned, proven steps. One marketplace; install the plugins you want.

## Install

Add the marketplace once:

```
claude plugin marketplace add cmorancie-mspf/claude-plugins
```

Then install a plugin by name:

```
claude plugin install rebuild-factory@production-ai
```

From a local copy of this repository, give the folder's path in place of `cmorancie-mspf/claude-plugins`.

## Plugins

| Plugin | What it is for | Status |
|---|---|---|
| [rebuild-factory](rebuild-factory/README.md) | Audit an existing codebase, write a plan a cheaper model can build from, and run the rebuild as a loop in which each small session is reproduced from a clean clone and attacked before it is merged | Early: see its notice |

### rebuild-factory

For a codebase that exists, mostly works, and that you do not trust. The rule behind it: **a builder's report proves nothing; only a test that fails when the code is wrong counts.**

> **Read this before you run it.**
>
> - The build stage starts a coding agent (OpenCode) with its commands **auto-approved**. Nobody watches each command.
> - The plugin ships a rules file that refuses pushes and common deploy commands. It matches command text. **It is not a sandbox.** Edit it for your project's own deploy commands before the first session.
> - Run it on a machine and a repository where an unattended coding agent is acceptable, with no production credentials in reach.
> - **Status: early.** The method comes from one rebuild that ran this way from audit to build. The helper script and the bridge are tested. The skills and agents have not yet been run on a second codebase.

In a chat opened on the repository you want rebuilt:

| # | Type | What happens |
|---|---|---|
| 1 | `/rebuild-factory` | Sets the project up and asks for a few settings |
| 2 | `/factory-audit` | Four independent reviewers audit; a fifth tries to disprove the serious findings |
| 3 | `/factory-direction` | You decide what the system is for and what is kept |
| 4 | `/factory-plan` | Writes the plan: requirements, tests, expected values, small sessions |
| 5 | `/factory-plan-review` | Six reviewers try to build from the plan on paper |
| 6 | `/factory-conduct` | The build loop, session after session, in a fresh chat |

`/factory-config` shows and changes the settings at any time.

Requires Node 20 or later and git; the build stage also needs [OpenCode](https://opencode.ai), signed in, with a model for the builder.

- **Guide for owners:** [rebuild-factory/docs/USER-GUIDE.md](rebuild-factory/docs/USER-GUIDE.md)
- **What ships, and the method:** [rebuild-factory/README.md](rebuild-factory/README.md)
- **The OpenCode bridge alone, and how to support another builder tool:** [rebuild-factory/bridge/README.md](rebuild-factory/bridge/README.md)

## Layout of this repository

```
.claude-plugin/marketplace.json   the list of plugins
<plugin>/                         one folder per plugin
  .claude-plugin/plugin.json
  README.md
  skills/  agents/  ...
```

To add a plugin: put its folder at the top level, add an entry to `marketplace.json` with `"source": "./<folder>"`, and add a row to the table above. Run `claude plugin validate .` and `node .github/check.mjs` before committing.

## Contributing

Reports of what did not work on your codebase are the most useful contribution. See [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md) for reporting a security problem. Never put a real project's findings, plans or data into this repository.

## Licence

MIT. See [LICENSE](LICENSE).

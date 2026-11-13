# Claude Code plugins

Plugins for engineering work done as planned, proven steps. One marketplace; install the plugins you want.

## Install

Add the marketplace once:

```
claude plugin marketplace add production-ai-eng/claude-plugins
```

Then install a plugin by name:

```
claude plugin install rebuild-factory@production-ai
claude plugin install transcribe@production-ai
claude plugin install expertise-miner@production-ai
```

From a local copy of this repository, give the folder's path in place of `production-ai-eng/claude-plugins`.

If you are an AI agent: [INSTALL.md](INSTALL.md) is written for installing these for someone, [llms.txt](llms.txt) indexes every document, and [AGENTS.md](AGENTS.md) has the rules for changing this repository.

## Plugins

| Plugin | What it is for | Status |
|---|---|---|
| [rebuild-factory](rebuild-factory/README.md) | Audit an existing codebase, write a plan a cheaper model can build from, and run the rebuild as a loop in which each small session is reproduced from a clean clone and attacked before it is merged | Early: see its notice |
| [transcribe](transcribe/README.md) | Turn an audio or video file, or a URL, into a transcript, processed on your own machine. No API key; the audio is not sent to any speech service | In regular use on Windows; untried on macOS and Linux |
| [expertise-miner](expertise-miner/README.md) | Pull a YouTube channel's transcripts into a searchable local corpus, then mine them for an expert's research questions, rules of thumb and research steps, each with a quote checked against the transcript, a timestamp and a way to test it | New: see its notice |

### rebuild-factory

For a codebase that exists, mostly works, and that you do not trust. The rule behind it: **a builder's report proves nothing; only a test that fails when the code is wrong counts.**

> **Read this before you run it.**
>
> - The build stage starts a coding agent (OpenCode) with its commands **auto-approved**. Nobody watches each command.
> - Its rules file refuses the plain forms of `git push` and of common publish and deploy commands by matching command text. A different spelling, a script that deploys from inside, or another tool gets through. It is not a sandbox. Add your project's own deploy commands before the first session.
> - The control that actually holds is where the builder runs: no production credentials in reach, and a remote its credentials cannot write to.
> - The audit and every review run the repository's own code on your machine.
> - Run it on a machine and a repository where an unattended coding agent is acceptable, with no production credentials in reach.
> - **Status: early.** The method comes from one rebuild that ran this way from audit to build. It was reviewed by an independent red team before this release. The helper script and the bridge have been exercised on Windows only. The skills and agents have not yet been run on a second codebase.

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

### transcribe

Say "transcribe <file or URL>" in any chat. See [its README](transcribe/README.md). Requires Python 3.9 or later; on first use it checks what is missing and installs the packages only when you agree. The first run downloads a speech model of 0.5 to 3 GB.

### expertise-miner

For finding out how an expert actually works, from what they have said on YouTube. The rule behind it: **a reader's report proves nothing; only a quote found in the stored transcript counts.**

> **Read this before you run it.**
>
> - It makes automated requests to YouTube from your address, slowly on purpose. YouTube may still refuse an address that asks for a lot; the pull then stops using it, and stops itself when no other proxy route is left (without a proxy, at once).
> - Whether collecting and studying a channel's transcripts is acceptable for your purpose is your decision.
> - Mined items report what was said. Nothing checks whether it is true.
> - **Status: new.** Tried on Windows, on a handful of videos, with SQLite and no proxy. Search by meaning has been tested against a stand-in endpoint only.
> - Search by meaning is optional and off by default. If you turn it on with a hosted embeddings endpoint, the text of your stored transcripts and the wording of your searches are sent to that endpoint.

| Type | What happens |
|---|---|
| `/yt-setup` | Optional: asks which database, which search and whether to use a proxy, and writes your settings file with placeholders where secrets go |
| `/yt-pull @SomeChannel` | Pulls the channel's transcripts in the background, skipping what is already stored |
| `/yt-search "some phrase"` | Finds the passages where it was said, ranked, with quotes and links to the moment |
| `/mine-expertise @SomeChannel` | One reader per video writes items; a tool rejects every item whose quote is not in the transcript; the rest are clustered into a question bank |

Requires Node 18 or later and Python 3.9 or later. Pulling needs two Python packages, installed on first use only when you agree. Storage is a local SQLite file; MongoDB, a proxy, and search by meaning through an embeddings endpoint you choose are optional settings. See [its README](expertise-miner/README.md).

## Layout of this repository

```
.claude-plugin/marketplace.json   the list of plugins
<plugin>/                         one folder per plugin
  .claude-plugin/plugin.json
  README.md
  skills/  agents/  ...
```

To add a plugin, follow [PLAYBOOK.md](PLAYBOOK.md): a plugin is listed in `marketplace.json` only after an independent review has approved it, and the commands to run before a commit are in [AGENTS.md](AGENTS.md#before-you-commit).

## Contributing

To write or change a plugin, follow [PLAYBOOK.md](PLAYBOOK.md). Reports of what did not work on your codebase are the most useful contribution. See [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md) for reporting a security problem. Never put a real project's findings, plans or data into this repository.

## Licence

MIT. See [LICENSE](LICENSE).

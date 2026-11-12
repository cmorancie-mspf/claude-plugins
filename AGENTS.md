# AGENTS.md

Instructions for an AI agent working in this repository. A person should read `README.md` first.

## What this repository is

A Claude Code plugin marketplace named `production-ai`. Each top-level folder with a `.claude-plugin/plugin.json` is one plugin. `.claude-plugin/marketplace.json` lists them.

| Plugin | What it does | Where to start reading |
|---|---|---|
| `rebuild-factory` | Audits an existing codebase, plans a rebuild, and runs it as a loop in which a separate coding agent builds and every session is reviewed from a clean clone | `rebuild-factory/README.md`, then `rebuild-factory/references/` |
| `transcribe` | Local speech-to-text for a file or a URL | `transcribe/README.md` |
| `expertise-miner` | Pulls YouTube transcripts into a searchable corpus and mines them for an expert's questions, rules of thumb and research steps, with every quote checked against the transcript | `expertise-miner/README.md`, then `expertise-miner/server/` |

If you were asked to **install** a plugin for someone, read `INSTALL.md`. If you were asked to **use** one, read `llms.txt` and that plugin's README. The rest of this file is for changing the repository.

## Layout of a plugin

```
<plugin>/
  .claude-plugin/plugin.json   name, version, description
  README.md                    for people
  skills/<name>/SKILL.md       one folder per skill; the folder name is the skill's name
  agents/<name>.md             subagents; the file name is the agent's name
  references/  templates/      read by the skills when needed
  scripts/  bridge/  server/   code the skills run
  tests/                       tests for that code
```

Inside a skill or an agent file, refer to the plugin's own files as `${CLAUDE_PLUGIN_ROOT}/...`. That variable is filled in for skill and agent text only. It is not set in a shell, and it is not filled in inside a reference file that is opened with a read tool, so do not write it there.

## Before you commit

Run all of these from the repository root. Every one must pass.

```
node .github/check.mjs
claude plugin validate .
claude plugin validate ./<each plugin folder>
node rebuild-factory/tests/test_factory.mjs
python expertise-miner/tests/test_miner.py
```

- `check.mjs` verifies the manifests, the skill and agent front matter, that every `${CLAUDE_PLUGIN_ROOT}` path exists, that every script parses, and that no machine path or secret-shaped string is committed. CI runs it and compiles the Python scripts.
- `test_factory.mjs` uses a stand-in for OpenCode, calls no model and spends nothing. A few of its checks need git and OpenCode 2 installed.
- `test_miner.py` uses the standard library only (`python3` where `python` is not on the path). Listing and transcript fetching are replaced by stand-ins: it contacts nothing and needs no package installed. Never make a test of `expertise-miner` send a real request.
- `transcribe` has no committed tests. If you change `transcribe.py`, test it with a stand-in for the speech model; do not load a model in an automated check.

## Rules that must not be broken

1. **Nothing specific to one project, person or machine.** No drive paths, user names, product names, real findings, real plans. Method goes in a plugin's `references/`; a project's content stays in that project.
2. **No statement about safety that is not true as written.** If a protection stops only the plain form of something, say so. If a check detects and does not prevent, say that. Each claim in a README, a guide or `SECURITY.md` must match what the code does; when you change one, change the other in the same commit.
3. **Never make the bridge or the helper script fail open.** In `rebuild-factory`, an unattended builder must not be startable without a rules file, and a plan folder must not be believed without the owner's acceptance. A change that adds a way round either is a defect, whatever else it fixes.
4. **A plugin is published only after an independent review has approved it.** A reviewer that did not write the change reads the files, tries to break them, and says approve. Fix, and have the same reviewer check again, until it does. Do not add a plugin to `marketplace.json` before that.
5. **One plugin per commit and per push** when publishing, so that each can be traced to its review.
6. **Do not run a real builder, spend money or load a large model in a test.** Use a stub.
7. **Never weaken the quote check or the politeness limits of `expertise-miner`.** An item reaches the output only when its quote is found in the stored transcript; workers never exceed distinct routes; the delay has a floor; a run of refusals stops the pull; only YouTube addresses built from a parsed id reach the downloader; configured credentials are filtered from every log line, job record and tool result the code writes; `mine_build` never believes `verified.jsonl` without checking it again. A change that adds a way round any of these is a defect.
8. **Bump the plugin's `version`** in its `plugin.json` when its behaviour changes.

## Adding a plugin

1. Put its folder at the top level, with the layout above and a README written for someone who has never seen it.
2. Have it reviewed (rule 4).
3. Add its entry to `.claude-plugin/marketplace.json` with `"source": "./<folder>"`.
4. Add its row and a short section to `README.md`, its lines to `llms.txt` and to the table at the top of this file, and what a person must be told before installing it to `INSTALL.md`.

## Commit messages

`area: what — why`, or for a release `plugin x.y.z: what changed`. Say what was tested and what was not. Commits use the GitHub no-reply address of their author; do not add a personal email address.

## Things that have gone wrong here before

- **A hook or a script that calls `python`** fails on machines that only have `python3`. Say which interpreter is needed, and print install commands that name the interpreter in use.
- **A config value used as a shell word.** Validate anything from a settings file that ends up in a command a person or an agent will run.
- **A check that reads its answer from the thing it is checking.** A record that says "this was accepted" must not live where the thing being accepted can write it.
- **A deny rule that matches too much or too little.** Test both lists: commands that must be refused, and ordinary commands that must not be.
- **Wording that outlived the code.** After changing behaviour, search the documents for the old claim.

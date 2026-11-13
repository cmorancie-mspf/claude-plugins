# Contributing

## What helps most

A report of what did not work when you ran a plugin on your own codebase: which stage, what it did, what you expected. Open an issue. Do not paste your project's findings, plans or code.

## Changes

1. Fork, and work on a branch.
2. Keep a plugin free of anything specific to one project: no machine paths, no product names, no real findings. Method goes in a plugin's `references/`; a project's content stays in that project.
3. Before opening a pull request, run every command in [AGENTS.md "Before you commit"](AGENTS.md#before-you-commit), from the repository root. That is the one list.
4. Say in the pull request what you ran it on and what you did not test.

## Adding a plugin

Follow [PLAYBOOK.md](PLAYBOOK.md). A plugin is added to `.claude-plugin/marketplace.json` only after an independent review has approved it (`AGENTS.md` rule 4).

## Commit messages

`area: what — why`.

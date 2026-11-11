# Contributing

## What helps most

A report of what did not work when you ran a plugin on your own codebase: which stage, what it did, what you expected. Open an issue. Do not paste your project's findings, plans or code.

## Changes

1. Fork, and work on a branch.
2. Keep a plugin free of anything specific to one project: no machine paths, no product names, no real findings. Method goes in a plugin's `references/`; a project's content stays in that project.
3. Before opening a pull request, from the repository root:

   ```
   claude plugin validate .
   claude plugin validate ./<plugin folder>
   node .github/check.mjs
   ```

4. Say in the pull request what you ran it on and what you did not test.

## Adding a plugin

Put its folder at the top level, add an entry to `.claude-plugin/marketplace.json` with `"source": "./<folder>"`, and add a row to the table in `README.md`.

## Commit messages

`area: what — why`.

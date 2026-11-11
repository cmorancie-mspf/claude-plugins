---
name: rebuild-factory
description: Entry point for auditing and rebuilding an existing codebase with a builder you do not have to trust. Sets a project up, says which stage it is at, and routes to the stage skills (factory-audit, factory-direction, factory-plan, factory-plan-review, factory-conduct). Use when someone says "/rebuild-factory", "set up the factory for this repo", "where are we in the rebuild", "red team and rebuild this codebase", "audit this and plan the fix", or wants to repeat the audit, plan and conductor loop on another project.
---

# Rebuild factory

For a codebase that exists, sort of works, and cannot be trusted: find out what is actually true of it, write a plan a cheaper model can build from, and run the rebuild in small sessions that are each proven before the next starts.

## The idea

**A builder's report proves nothing. Only a test that fails when the code is wrong counts.** Everything else follows from that: the audit distrusts the project's claims about itself, the plan owns the expected values so the builder cannot make them agree with its code, and the review reproduces each session from a clean clone and then breaks it on purpose.

The second idea is the split of roles. The owner decides direction. A capable model writes the plan and reviews. A cheaper model builds. The capable model is spent on judgement, not on typing.

## The stages

| # | Stage | Skill | Produces | Ends when |
|---|---|---|---|---|
| 1 | Audit | `factory-audit` | `audit/AUDIT-REPORT.md`: numbered findings and a ship answer | High findings are verified, not just asserted |
| 2 | Direction | `factory-direction` | `direction/DECISIONS.md` | The owner has decided what the system is for and what is kept |
| 3 | Plan | `factory-plan` | `plan/`, `fixtures/`, `prompts/` | The first sessions are ready and the plan passes its own checks |
| 4 | Plan review | `factory-plan-review` | `plan-review/`, `RULINGS.md` | Independent reviewers judge it buildable |
| 5 | Conduct | `factory-conduct` | Accepted sessions on the main branch, `handback/PROGRESS.md` | Every session is accepted, or the loop stops for the owner |

At any stage, `factory-config` shows and changes the settings.

Stages run in order. Do not start the plan before the owner's direction: a plan written from audit findings alone repairs the system that exists, which may not be the system that is wanted.

## Setting a project up

From the repository's root:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" init
```

It creates `factory-plan/`, keeps it out of git, and writes `factory.config.json`. Then run the first set-up of the `factory-config` skill: it asks the owner for the builder's model, the owner-only actions, the stop limits, auto-push and the helper models, and sets each. The owner never edits the file by hand. The phase and mutation commands are set at the plan stage, when the plan names them. `${CLAUDE_PLUGIN_ROOT}/references/layout.md` explains every key and the folder.

Before stage 5, check the bridge is loaded (`opencode_list` answers) and that the builder tool is installed. Before any of it, tag the commit the rebuild starts from as `<tag_prefix>baseline`.

## Where a project is

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" where
```

reports the next session and how far it has got, once a session map exists. Before that, the stage is the first one whose output file is missing. Tell the owner the stage, what the last one produced, and what the next one needs from them.

## What the owner should know before starting

- **The plan is the expensive stage.** A first plan is usually judged not buildable by its reviewers. That is the review working. Budget for a rewrite.
- **The plan is never finished up front.** What must be true is that the next session is ready. Making each session ready surfaces gaps that need rulings, every time.
- **The loop runs unattended but not unsupervised.** It stops for paid tests, owner-only actions, design rulings and its stop policy. The owner follows along in `handback/PROGRESS.md`.
- **One builder at a time on a small machine.** Memory, not model speed, is what limits a session.
- **Nothing here is a sandbox.** The builder's deny rules stop the obvious; the clean-clone review is what catches the rest.

## Keeping it shareable

The plugin carries method and templates only. A project's findings, plan and fixtures live in that project's plan folder and are not committed unless the owner chooses. Never copy a project's plan content into this plugin.

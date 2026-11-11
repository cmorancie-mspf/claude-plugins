---
name: factory-plan-review
description: Stage 4 of the rebuild factory. Have independent reviewers try to build from the plan on paper - buildability, consistency, safety, verification design, coverage, sequencing - then rule on what they raise, rewrite where they judge it not buildable, and repeat with a smaller second round until the first sessions are ready. Use when someone says "/factory-plan-review", "review the plan", "is this plan buildable", "do a final review of the plan with multiple agents", "red team the plan", or a rebuild plan has just been written.
---

# Factory plan review

The plan's author cannot see its gaps: the author knows what was meant. Reviewers who know only what was written can.

Reads `plan/` and `fixtures/`. Writes `plan-review/`.

## Round 1

Spawn one `plan-reviewer` per lens, each writing `plan-review/r1-<lens>.md`:

**buildability, consistency, safety, verification, coverage, sequencing.**

- Give each its lens, the plan folder and its report path. Do not tell them what you think of the plan.
- Start each on the model named in `models.plan_reviewer` of `factory.config.json` (pass it as the agent's model); if it is empty, leave the model out and the agent uses this chat's.
- They do not read each other's reports.
- Run as many at once as `limits.max_subagents` allows, and have them write as they go.
- This is where the best model is worth its cost. A gap found here costs an edit. The same gap found in session twelve costs a session, its review, and whatever was built on it.

## Rule

Read every report. For each finding, decide and record in `plan-review/RULINGS.md`:

- **Accepted**: the change to make, and where.
- **Modified**: the finding is right about the problem and wrong about the fix.
- **Rejected**: why. A finding is a proposal, not a verdict; a plan that absorbs every suggestion grows unreadable.
- **For the owner**: it turns on a decision that is theirs. Ask it singly, with your recommendation.

Give each ruling an id and group them by topic. Rulings bind: where a ruling and a plan file disagree later, the ruling wins, and the index says so.

## If the verdict is "not buildable"

Expect this of a first plan. Do not patch a plan that most reviewers could not build from: rewrite it as the next version, from the rulings. The usual changes are structural: smaller sessions, expected values moved into fixtures, guesses turned into spikes, one index that says which text wins, a reading list per session.

Keep the rejected version out of the builder's sight. Add it and `plan-review/` to `builder_must_not_read`.

## Round 2

Smaller: **consistency, buildability, safety**, against the rewritten plan and the rulings (`r2-<lens>.md`). The questions are whether the rewrite did what the rulings said and whether it introduced new contradictions. A numbering clash between two editors is typical here.

Finish with a closing check of your own: every ruling applied; every audit finding in the traceability table; the first three sessions ready by the standard (Read line filled, fixtures present, no open question that blocks them).

## Cost

Reviewers on the strongest model, at high effort, are worth it for round 1. After that, split the work: mechanical edits and extraction on a cheap model, precise transcription (fixtures, tables) on a mid model, rulings and the closing check on the strongest at moderate effort, and a script for anything that can be checked by one, such as ids and cross-references.

## Done when

The reviewers judge the plan buildable at least up to a named session, the rulings are applied, and the first sessions are ready. The rest of the plan is made ready session by session by the conductor. Tell the owner what was changed, what remains open and before which session each open item must close. The next stage is `factory-conduct`.

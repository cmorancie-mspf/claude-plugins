# The change-factory method

How a list of changes to a working system becomes reviewed, tested, merged and released code. The skills
follow this file; the helper (`scripts/cf.mjs`) refuses the steps whose gates are not met. Where this file
and the helper disagree, the helper is what runs: fix this file.

## Words

- **Owner**: the person at the keyboard. Decides direction, answers questions, says yes to every deploy, push
  and move of the main branch.
- **Conductor**: the Claude Code chat that runs the loop. Writes nothing into the run's records itself: every
  record goes through the helper, which stamps it.
- **Stream**: one workstream. One branch, one worktree, one brief, rounds of work, one merge.
- **Integration branch**: the branch every stream is merged onto, `--no-ff`, so each stream is one merge commit.
- **Helper**: `cf.mjs`, the only writer of the event log. It runs the workers and the tests itself and reads
  their results; the conductor never types a result the helper can read.

## Roles

| Role | Who | Writes |
|---|---|---|
| brief_writer | a subagent, no shell | the stream's brief |
| worker | a coding agent on OpenCode, started by the helper through the bridge, auto-approved under deny rules | commits on the stream branch |
| worker_escalation | a subagent, after `escalate_after` failed rounds | commits on the stream branch |
| round_reviewer | a subagent, no shell | one review file per round |
| stream_red_team | a subagent, no shell, on the strongest model | one red-team report per eligible stream |
| pre_merge_red_team | the same agent, only for streams the owner named in `roles.pre_merge_red_team.streams` | one report on the stream's head, before its merge |
| research | a subagent, no shell (or the configured research runner) | one finding file and an owner question |

Every role's model comes from the project's config. A fallback is per role. A red team that runs on its
fallback records an **owed pass**: the pass on the wanted model is still owed, and a stream that ships on
cannot be released until it is paid or the owner waives it.

## Independence

- A round reviewer is never the model that wrote the round (for the conductor's own commits, never the
  conductor's model).
- A red team is never the model of a reviewer or an author of that stream.
- A fallback that would break this is allowed only as an owed pass.
- The red team reads the stream's merge diff, the brief and the merged branch. It does not read earlier
  reviews; the conductor removes duplicates afterwards.

The helper checks these rules against the dispatch records. It cannot see which model actually answered a
subagent call, or that the agent wrote its own file: those are the conductor's honesty.

## One stream, as states

```
proposed -> confirmed (owner: tier + ship mode) -> briefed -> [needs owner] -> ready
ready -> round n: dispatched -> ended -> reviewed (MERGEABLE | CHANGES NEEDED) -> next round | tested
tested (green at its code head) -> merged (merge commit M) -> [red team due] -> cleared | fixing
fixing -> fix dispatch -> fix reviewed MERGEABLE -> combined test green -> cleared
cleared -> stale (a later merge touched its files) -> red team due again, scoped to that merge
cleared -> ships: deploy (on) | switch-on later (off) | owner question (research)
```

- **Tier** (low / high) and **ship mode** (on / off behind a flag / research) are set at intake and confirmed
  by the owner, because they decide whether a red team runs.
- **Needs owner**: a changed premise, a brief decision marked as changing what is built (or not marked), or a
  question for the owner. Dispatch is refused until the owner's answer is recorded. Recording the brief again
  can add to what waits for the owner, never remove it: only the owner's answer clears it.
- A **research** stream ends at a finding file and an owner question. It never becomes code in the same run.
  The finding is written by the research analyst (or the configured research runner); the owner's answer is
  recorded, and what follows from it is a carry item for a later run.

## Rounds and attempts

- An **attempt** is one worker run. The helper reads how it ended from the bridge (exit code, how the log
  ended) and whether the branch moved.
- A **round** is an attempt that ended with new commits. It is reviewed.
- An attempt with no new commit (it hit a rate limit, ran out of quota, died, stalled, was stopped, or
  finished without committing) is not a round. The next dispatch is the same round, next attempt. Run ids are
  `<run>-<stream>-r<n>-a<k>`.
- A **failed round** is one whose review said CHANGES NEEDED, or whose stream's red team said CHANGES NEEDED.
- A fix on the integration branch is a round of the stream whose finding it answers.
- After `escalate_after` failed rounds the next round goes to `worker_escalation`, and not before.
- A head is reviewed once. CHANGES NEEDED is answered by a new round, not a second review of the same head
  (a second review is allowed only to pay an owed pass).

## Heads

- The **code head** of a branch is its newest commit that is not a commit of record files only (files under
  `docs_paths`: briefs, reviews, reports, status). Committing a review does not move the code head, so the
  review still covers it.
- Between a stream's last reviewed worker round and the commit that is tested or merged, only record files,
  recorded `generated` commits and reviewed `test_only` commits may stand.
- Every test result is tied to the exact code head it ran on. A merge and a release accept only results for
  the code head they take.

## The integration branch

Its commits are each one of: a stream's merge; a recorded `generated` commit (only generated paths); a recorded
`test_only` commit (only test paths, reviewed by a model other than the conductor's); a fix by a dispatched
worker (reviewed); or record files only. Anything else is "not accounted for" and stops the combined test.

- A merge commit holds what git alone makes of the two branches, plus the resolution of the files git could
  not merge (and generated files, which `regenerate` rebuilds). Anything else in it is refused at `merge
  record`: a change of code goes through a worker.
- A merge's conflicts are found by git (`merge-tree`), not by the conductor's word. A conflict only in
  generated paths is settled by regenerating, and does not make the stream red-team eligible. Any other
  conflict resolution makes the later stream eligible.
- Generated files are rebuilt by `regenerate` on the integration branch. Only a clean run at the current code
  head counts: a run that changed files is committed, recorded, and run again.
- Suites listed in `tests.regenerated_on_integration` (golden files, generated contracts) are required on the
  integration head only, not on a stream's own branch.

## Red teams

- One per eligible stream, on the merged branch, scoped to its merge commit. Eligible = tier high, or a real
  conflict resolution in its merge, or it went outside its lane.
- The verdict records the integration head it read. If a later merge touches the stream's files, the verdict
  is stale and a pass scoped to that later merge is due.
- CHANGES NEEDED starts the fix loop: a fix dispatch, a review that names each finding as closed, a combined
  test. No second red team unless it goes stale or the owner asks.
- Every pass counts in `max_red_team_passes`: stand-ins, paid owed passes, stale re-runs.
- A red team that reads a conflict resolution is never on the conductor's model, which wrote it.
- **Before a merge**, only on the owner's choice at intake: a stream named in `roles.pre_merge_red_team.streams`
  gets a red team on its reviewed, green head, and `merge record` refuses it until that verdict is MERGEABLE.
  It does not replace the red team on the merged branch.

## The release

Per deploy unit, its own yes, with the rollback named first. Then main moves (fast-forward to the integration
branch) and the push: each the owner's yes. Main moves only when it still equals the run's base and every
unit that carries code is recorded ok, or the owner records that main moves without it.

## Budgets

A run takes its budgets from the config when it opens. The owner changes them inside an open run with
`owner budget <key> <n> --why <reason>` (an owner record); an edit of the config applies from the next run.

## The records

The helper keeps the run's log in the user's home folder, hash-chained. Every command that reads or writes a
run holds the project's lock from its first read to its last write, so two commands at once cannot both pass
a gate or take the same id. A log whose chain is broken is not read: every command that reads the run stops
until it is whole again.

## Waiting

The conductor never waits in a foreground loop. Every wait (a worker run, a test run) is a background shell
command; the session is woken when it exits. A command ending in `&` inside a foreground call does not wake
anyone.

## What v1 is and is not

In v1: one repository per run; OpenCode workers through the bundled bridge; subagent roles; local tests or a
configured CI command; per-unit release; a carry register across runs; a status table in chat.

Not in v1: more than one repository per run (a change to two repositories is two runs); another worker
bridge; a live status page; a signature on the event log; refusing compute on the owner's machine beyond the
agents' tool lists; a check that a subagent ran on the model it was dispatched with.

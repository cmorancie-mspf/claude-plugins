# What a buildable plan contains

The plan is written for a builder that is a weaker model than its author, has none of the author's context, cannot ask a question while it works, and will do what the words say. A plan that a staff engineer could build from is not yet that plan. The test of it is the plan review, where reviewers who did not write it try to build from it on paper.

## The files

1. **`INDEX.md`**, short enough to read in full every session (about 250 lines). It holds: what is being built and why, in one paragraph; who decides what; the file map; the words to use exactly; the rules of every session; which text wins when two disagree; the do-not list; the session map with each session's state; the owner's actions; the risks the owner accepts; what is still open in the plan.
2. **Area files**, one per part of the system. Each requirement is one numbered sentence that a test can show true or false. Design reasoning sits beside the requirement it explains, not in a separate essay.
3. **`verification.md`**: the test layers, the fixtures, the mutation list, the phase command, the handback format. See `verification-standard.md`.
4. **`phases.md`**: the session map and one block per session. `phases.json` is the same list as data.
5. **`fixtures/`**: the expected values, as data. See below.
6. **`traceability.md`**: every audit finding, and the requirement, session or accepted risk that answers it. A finding with no row is a finding the plan forgot.

## A session block

A session is the unit that is built, reviewed and merged. Make it small enough that the builder finishes in one sitting and the reviewer can hold it in mind: one seam of the system, a handful of acceptance tests.

Each block has, in this order:

| Field | Content |
|---|---|
| Heading | `### Session <id>: <what it builds>` |
| Read | The exact sections of the area files this session needs, and nothing else. An unfilled Read line means the session is not ready. |
| Builds | The files it creates or changes, and the directories it may touch. Everything else is out of scope. |
| Does not build | What a later session is assigned, where a builder might be tempted to start it. |
| Tasks | The order of work, where order matters. |
| Acceptance tests | One row each: id, layer, setup, what must be observed, and the defect it exists to catch. |
| Mutations | The defects the mutation run puts back for this session, each with the test that must catch it. |
| Exit | The phase command exits 0; the mutation run exits 0; the handback exists. Plus anything only the owner can do. |
| Carried | Findings from the previous review that this session fixes first. The conductor writes this. |

## Plan-owned fixtures

Wherever a test compares against an expected value that is a matter of design (a state table, a role table, a list of refusals with their codes, a set of limits), the plan states that value as a data file under `fixtures/`, with a manifest of hashes. The builder copies the files byte for byte into the repository and its tests read them.

The reason: a builder that writes both the code and the expected value will make them agree. With the expected value owned by the plan, a disagreement means the code is wrong or the plan is, and either way the builder stops and reports.

Fixtures need a provenance note (which section each file transcribes) and a checker script that the phase command runs.

## Spikes

Where the design rests on a fact about a platform or a tool that nobody has measured, the plan does not guess. It schedules a spike session before the first session that depends on the fact. A spike writes no product code: one small script per question, the raw output kept beside it, and an answer of yes, no, partly or not determined. The plan authors write the answers into the area files before the next session starts.

## Which text wins

A long plan contradicts itself. Say in the index which source wins, in order, for example: a ruling, then a fixture, then the session block, then the area file, then the index. Tell the builder that a contradiction it cannot settle from that order is a reason to stop, not to choose.

## The do-not list

State what the builder must never do, and make each item something a check can enforce where possible: no deploy, no push, no edit of a fixture or an earlier test, no file outside the session's directories, no secret printed, no skipped test. An instruction with no check behind it is a request.

## Checks the plan must pass before review

These are the ways a first plan usually fails. Check each before spending reviewers on it.

- **Every session fits one sitting.** If a block lists more than about eight acceptance tests or touches more than one seam, split it.
- **Every expected value is written down.** Search the acceptance tests for "correct", "valid", "appropriate", "as expected". Each is a value the builder would have to invent.
- **Every platform fact is measured or scheduled.** Search for "should", "probably", "is documented to".
- **Every requirement has a session, and every session's requirements exist.** A module named in an area file and assigned to no session is found only when its first caller is built.
- **The reading load is bounded.** No session is told to read a whole area file.
- **The first sessions build the checking machinery.** The phase command, the static layer and the mutation tool come before the product code they will judge.
- **Nothing depends on the audit.** The builder is told not to open the audit or any rejected draft: code built from a description of the old system is the old system.
- **Each owner action has a session and exact commands.**

## Readiness is per session

The plan does not have to be finished before the first session starts, and it will not be. What must be true is that the next session is ready: its Read line filled, its fixtures present, its open questions ruled. Filling the Read line is architect work, not clerical work: it is the moment the gaps between a block and the area files show up, and each gap needs a ruling written into the block.

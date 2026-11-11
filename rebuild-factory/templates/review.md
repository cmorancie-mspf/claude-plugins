# Review of session <id> — <date>

Verdict: <accepted | not accepted, findings sent back (failed review n of limit)>. <Merge commit and tag, or "not merged">.

## Reproduced

From a fresh clone of `<branch>` at `<commit>`, after the install command:

- The phase command: exit code, tests passed, and whether the summary equals the builder's (name any field that differs and why).
- The mutation command: exit code, each mutation and the test that killed it.
- Fixtures against the plan's copy.
- Scope: files added, changed, deleted; all inside what the block allows, or which are not.
- History: each test committed before its code, and failing at its own commit; or which are not.
- The other tool modes.

## Breakages

| # | Change | Derived from | Expected to fail | Result |
|---|---|---|---|---|
| 1 | | guard / guard's guard / line removal / carried finding | | killed / survived |

For each survivor: which of the four judgements applies, and why.

## Not checked

What the review did not run or read. Be exact.

## Exemptions and opt-outs

Every exemption in the static checker and every opt-out in the summary, quoted, each with whether the plan allows it.

## Deviations, each judged

1. <the builder's deviation>: accepted, ruled, or sent back, with the reason.

## Rulings made

Each ruling, where it was written into the plan, and that the owner may overturn it.

## Findings

Each with the step that failed and the change that would close it. For an accepted session: findings carried forward, and to which session.

## Open

For the owner; for the plan.

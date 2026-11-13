---
name: change-status
description: Show where a change-factory run stands - the status table rendered from the run's event log (each stream's tier and ship mode, brief and premise, rounds and attempts, last review, tests at its head, merge, red team, owed passes, what it is cleared for), the integration branch, what waits for the owner, and budgets used. Read only. Use when someone says "/change-status", "where are we", "status of the run", "show the table", or after each step the change-run loop reports.
---

# Change status

Run the helper as the entry skill `change-factory` says:

    cd "<repository>" && node "${CLAUDE_PLUGIN_ROOT}/scripts/cf.mjs" status

It prints the table and four lines below it. Show the table as it is printed: do not re-render it from memory
and do not add rows the helper did not print. Then, in at most three lines of your own:

- what waits for the owner (from "Waiting on the owner"),
- what is running now (`+... running` in the rounds column),
- the next step you will take.

`status --json` gives the same facts as data. `reconcile` compares the log with git and the bridge;
`carry list` shows what is carried from earlier runs; `verify` checks the log's chain (a hand edit or a lost
line; it is not a signature).

Columns: **tier/ship** low or high / on, off or research; **brief** the premise status, and NEEDS OWNER when the
stream waits; **rounds** reviewed rounds, failed ones, attempts that were not rounds, and what is running;
**review** the last round review's verdict; **tests @head** suites at the stream's last round; **merged** the
merge commit, with (conflict) if git found one; **red team** the verdict and model, "fixing" after CHANGES
NEEDED, "stale: due again" after a later merge touched its files, "due" when none yet; **owed** passes run on a
fallback, and whether paid or waived; **cleared for** deploy, switch-on, owner question, or not yet.

# The verification design

The rebuild rests on one rule: **a builder's report proves nothing; only a test that fails when the code is wrong counts.** Everything here exists to make that rule something a machine checks.

The plan's `verification.md` adapts this standard to the project's language and tools. The names below are roles, not file names.

## One command per session: the phase command

One command decides a session. It takes the session id, runs everything that must hold at that point, exits 0 or not, and writes a summary file. The builder reports no result from any other command, and the reviewer runs the same one.

It is cumulative: session N's run includes every earlier session's tests. It fails for more reasons than a failing test:

| Check | Fails when |
|---|---|
| Expected tests | An acceptance test the plan assigns to this session or an earlier one is missing. The expected list is read from the plan's data files, not typed into the tool. |
| No hollow tests | A test is skipped, filtered, marked todo or only, or makes no assertion. |
| Fixture integrity | A plan-owned fixture differs from the manifest by one byte, or a file is missing from the manifest. |
| Static layer | The source contains a pattern the plan bans, or a file exists outside what the plan allows. |
| Clean tree | There are uncommitted changes (with an explicit switch to allow it for the reviewer's own mutations). |
| Opt-outs | A test used an escape hatch of the harness that the plan does not allow that test. |

The summary file records: the session, the commit, each test id with its result and assertion count, the fixture hashes, the static results, the opt-outs, and the tool versions. Two runs at the same commit produce the same summary apart from times.

The phase command also has a mode that prints the generated parts of the handback from the same run, and a mode that compares its summary with another one.

## The static layer

Rules checked by reading the source, for things a test cannot see: a banned call, an import across a boundary, a machine path, a secret-shaped string, a document that claims something that does not exist. Each rule has an id, a pattern, the paths it covers and the paths it exempts.

Exemptions are where a static layer rots. Every exemption is listed in one place with its reason, and the reviewer reads the list at each review.

## Mutation checks

A mutation is a small patch that puts a defect back into the product. The mutation run applies each patch in a scratch copy, runs the named test, and expects it to fail. A mutation whose test still passes is a survivor, and a survivor fails the session.

The plan lists the mutations per session, each chosen for a defect that matters: remove an authorisation check, drop a state transition's guard, return success without writing. The builder writes the patch files; the reviewer checks that each patch does what its header says and nothing else.

## Tests before code

For each acceptance test: write it from the plan, run it, see it fail, commit it, then write the code. The order is visible in the branch history. A file that holds assertions (a self-test of a harness module, for example) is committed before the module it tests, for the same reason.

The reviewer checks the order from the history and checks out the commit that added the tests to confirm they fail there. A test that passes at its own commit either tests nothing or was written after the code.

## Test layers

Name the layers and say what each may touch, cheapest first. A usual set:

- **static**: reads source and documents; runs nothing.
- **core**: the product's logic in one process, against stand-ins for the platform (storage, clock, timers, randomness, network) that refuse everything the real platform refuses.
- **integration**: real processes and real tools on this machine.
- **live**: the deployed system or a paid service. Never in the phase command; started by hand with the owner present.

Stand-ins are checked against the real platform's recorded answers from a spike, so a stand-in that is more permissive than the platform is caught.

## Rules for the builder

1. Test first.
2. Fixtures are the plan. Do not edit one. If the code and a fixture disagree, stop and report.
3. Never weaken a test: no changed expected value, no skip, no edit of an earlier session's test without a ruling.
4. One command. Report nothing from any other.
5. Say what was not done. An unfinished item listed as not done is a normal outcome. An unfinished item reported as done fails the session.
6. When the plan looks wrong, stop. Write what each place says and ask.

## What the builder hands back

`handback/<session>/handback.md`, with the summary files beside it. Test output is not pasted in: the reviewer runs the command and compares the files. The headings, in this order (the template is `templates/handback.md`):

| # | Heading | Content |
|---|---|---|
| 0 | Identity | Branch, full commit id, the previous accepted tag, tool versions, hash of each summary file. |
| 1 | Summary | What now works that did not. At most ten lines. No "verified" or count without a test id beside it. |
| 2 | Phase command | The command, its exit code, the summary's path. |
| 3 | Acceptance tests | Generated. By hand only: any test that could not be written as specified, what the plan says, what was done. Such a test is left failing, not skipped. |
| 4 | Requirements | Generated: requirement to tests. Every requirement of the session with no test, and why. |
| 5 | Mutations | Generated: id, killed or not, by which test. |
| 6 | Opt-outs | Generated: every escape hatch used, with test and reason. |
| 7 | Changes to earlier tests, fixtures or harness | Each with a reason. "None" if none. |
| 8 | Spikes | Each note's path and each question's answer word. |
| 9 | Deviations from the plan | Anything done differently, and why. Anything in the plan the builder believes is wrong. |
| 10 | Not done | Everything unfinished. |
| 11 | Needs the owner | Actions or answers only the owner can give, with exact commands. |
| 12 | Files | Added, changed, deleted against the previous accepted tag. |
| 13 | Least sure of | The five tests or behaviours the builder trusts least. |

A builder that is blocked writes the handback anyway, with the word `blocked` under heading 10 and the question under heading 9, and ends its turn. That is how a builder that cannot ask mid-run asks.

You are doing session **{{SESSION}}** of the rebuild of {{PROJECT}}. Do this one session and then stop.

**Where things are.** There are two folders, and they have different jobs.

- **Your worktree: `{{WORKTREE}}`.** A git worktree of the repository on branch `{{BRANCH}}`. All code, tests and commits go here. Run every command from here.
- **The plan folder: `{{PLAN_DIR}}`.** It holds the plan, the fixture files and the handback folder. It is read-only reference, with one exception: you write your handback into its `handback/{{SESSION}}/` folder.

Do not change any other file in the plan folder or in the main checkout, and do not run git commands in the main checkout.

**What this is part of.** {{PROJECT_PARAGRAPH}}

The rebuild is split into small sessions. Each one is reviewed and merged before the next starts, so that a mistake is caught while it is one session old. Your session is one of those steps. Its value is that it does exactly what its block says and that its tests can show it.

**What to read, in this order.**

1. `{{PLAN_DIR}}/plan/INDEX.md`. It is short: the vocabulary, the rules of every session, the do-not list, and which text wins when two disagree.
2. Your own session block in `{{PLAN_DIR}}/plan/phases.md`. Find it by searching for the heading `### Session {{SESSION}}`.
3. Exactly the sections named on your block's `Read` line, and nothing more from those files.
4. `{{PLAN_DIR}}/plan/verification.md`: only the handback section and the rules for the builder.
5. The repository's own instructions for agents, if it has a file of them.

When you meet an id that is not on your reading list, search for that id and read the section it is in. Do not read a whole area file: most of it is about other sessions, and reading it uses the context you need for the work.

Do not open any of these: {{MUST_NOT_READ}}. Some describe the system before the rebuild or a design that was rejected. Code built from them would be the wrong system, and it would look reasonable.

**How to work.**

- *One session.* Check with `git status` and `git log -1` that you are on `{{BRANCH}}` and that it contains the tag `{{PREVIOUS_TAG}}`; if not, stop. Do not start the next session, and do not build or stub anything a later session is assigned, even when a test seems to need it. That is a reason to stop and ask.
- *Test first.* For each acceptance test in your block: write it from the plan, run it, see it fail, commit it, then write the code. The order is visible in the branch history and the reviewer checks it. A file of assertions is committed before the module it tests.
- *Plan-owned files are copied, never edited.* The files under the plan's `fixtures/` are the plan's expected values. If your code and a fixture disagree, the code is wrong or the plan is; either way you stop and report.
- *Stay local and free.* These belong to the owner, and you do none of them: {{OWNER_ONLY}}. List what the owner must do, with the exact commands, under "Needs the owner". Do not open a secrets file or print a secret.
- *Never weaken a test.* Do not change an expected value, add a skip, or edit an earlier session's test so that yours passes.
- *Run long commands in the foreground.* If you start one in the background and wait, your turn can end before it finishes, and nobody is there to continue it.
- *Commit as you go.* Work that is committed survives a crash.

**When the plan looks wrong.** The plan is long and may contradict itself. If two plan files disagree in a way the index's precedence order does not settle, if a fixture disagrees with the text, or if a test cannot be set up as its row says: stop. Write down what each place says, with file and section. Do not pick the side that seems better and do not design around the gap. A weaker test that passes is worse than a correct test left failing.

**You cannot ask a question while you work.** Nobody is watching this run and nobody approves your commands. To ask, write the handback for the work that is finished, put the word `blocked` under "Not done" and the question, with what you expected and what happened, under "Deviations from the plan". Then end your turn. The answer arrives as your next message.

**What "done" means.** Both of these:

1. `{{PHASE_COMMAND}}` exits 0 on a clean tree and writes its summary file, and `{{MUTATE_COMMAND}}` exits 0.
2. `{{PLAN_DIR}}/handback/{{SESSION}}/handback.md` exists, with the headings of the handback template in order, and the summary files beside it.

Report no result from any other command. Anything unfinished goes under "Not done". That is a normal outcome and costs nothing. Unfinished work reported as done fails the whole session. **Do not end your turn before the handback file exists.**

**How your work is checked.** The reviewer does not read your output first. It clones the repository fresh, with no plan folder in it, checks out your commit, runs the phase command, compares its summary with yours, compares the fixtures with the plan's copy, and checks from the history that each test was committed before its code. Then it breaks things on purpose: it removes a line of your code that makes a decision, or switches off a check you added, and expects a test to fail. A test that still passes fails the session. So pasted output proves nothing, and neither does the word "verified". Only a test that fails when the code is wrong counts. Write those.

{{SPIKE_BLOCK}}**Notes for this session.**

{{NOTES}}

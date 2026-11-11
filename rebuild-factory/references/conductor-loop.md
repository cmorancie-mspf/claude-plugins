# The conductor loop

The conductor is one Claude session that plays three parts: it drives the builder, it reviews each session, and it is the plan's author between sessions. The owner reads a log and is asked only for what only the owner can decide.

## Roles

| Role | Who | Does | Never does |
|---|---|---|---|
| Owner | The person | Sets direction, rules on design, takes the owner-only actions, sets the stop policy. | — |
| Conductor | A Claude session | Makes each session ready, starts the builder, answers its questions from the plan, reviews, merges, logs. | Takes an owner-only action; lowers the review bar. |
| Builder | A separate coding agent, usually a cheaper model, run through the bridge | Builds one session in its own worktree and hands back. | Merges, tags, pushes, deploys, edits a fixture, starts the next session. |
| Reviewer | A fresh subagent of the conductor | Reproduces from a clean clone and breaks things on purpose. | Sees the conductor's opinion of the build. |

## The bridge

The builder is started through the `oc-bridge` MCP server that ships with this plugin (`opencode_start`, `opencode_answer`, `opencode_status`, `opencode_stop`, `opencode_list`), or the same thing as a command line: `node "${CLAUDE_PLUGIN_ROOT}/bridge/oc.mjs"`.

- One run id is one builder session. Use `<project>-<session>`.
- `opencode_start` and `opencode_answer` return at once with a `wait_command`. Start it as a **background shell command**; the conductor is woken when it exits. Do not poll.
- The wait exits 0 when the turn finished, 1 when it failed or was stopped, 3 when nothing was printed for the stall time. Exit 1 covers a crash and a stop alike, so read `opencode_status` and the worktree before deciding what happened.
- Always pass the config file with the deny rules. Runs are auto-approved: the deny rules are what turn "do not deploy, do not push" from a request into a refusal. They match command text and are not a sandbox, which is one reason the review stays.
- The builder's conversation is kept on disk by the builder tool. A crashed or stopped run is continued in the same session with `opencode_answer`.

## Find your place

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" where`. It reads the session list and the accepted tags and reports the next session and how far it has got: ready, prompt written, worktree made, run started, handback present, review present. Then read the end of `handback/PROGRESS.md`. If a run for the session exists, read `opencode_status` before starting anything: an earlier conductor may have been part-way through.

## The loop, per session

**1. Make ready.**
- Fill the session's Read line: the exact sections it needs. A subagent may draft it from the block's requirement ids; the conductor checks it. Expect gaps between the block and the area files, and rule on each in writing, in the block. This is the largest piece of conductor work in a session.
- Write the previous review's findings into the block under "Carried".
- Produce the prompt: `factory.mjs prompt <session>` fills the kickoff template. Add a "Notes for this session" paragraph: what the last review found, the patterns the static layer will refuse, anything this machine does badly. Tell the builder how the reviewer works (remove a line, expect a failing test), so it writes those assertions the first time.
- Create the worktree from the main branch and run the install command in it.
- Add a "made ready" entry to `PROGRESS.md` before starting the run, so a restarted conductor knows.

**2. Build.** `opencode_start`, then the background wait.

**3. When the turn ends,** read `handback/<session>/handback.md` before the log.
- *A handback, not blocked:* go to the review.
- *Blocked, with a question:* if the plan answers it, or the index's "which text wins" settles it, answer with `opencode_answer`. Restate the question and name the files, because the builder may be resuming from a summary of its earlier context. Write the answer to a file beside the handback and record it for the review. If the answer changes a fixture or the plan, change the plan first and tell the builder to copy it again.
- *No handback:* the turn ended unfinished, crashed or stalled. Check the worktree: what is committed, whether the tree is clean. Continue the same run with a note of exactly where it stopped and what is still owed. Common causes worth naming in the note: a long command started in the background, so the turn ended while it waited; a turn that ended before writing the handback.
- A question that changes the design, a requirement or an expected value on its merits belongs to the owner.

**4. Review.** `references/review-protocol.md`, with a fresh `session-reviewer` subagent for the reproduction and the breakages. Do not run the reviewer while a builder is running on a machine short of memory. Delete the clone afterwards.

**5a. Accepted.**
- Merge to the main branch with `--no-ff`. Run the phase command on the merge commit. Create the annotated tag.
- Write `REVIEW.md`. Update the session's state in the index. Write carried findings into the next session's block. After a spike, write its answers into the area files and the fixtures.
- Remove the worktree and any scratch copies. Push if the stop policy says so.
- Append to `PROGRESS.md` and go on to the next session without waiting.

**5b. Not accepted.** Write the findings to a file beside the handback and send them to the same run with `opencode_answer`. Review again in full, and re-try every breakage that survived. Count the failed review.

## Counting, and when to stop

Three counts per session, each with a limit in `stop_policy`:

| Count | What adds to it | What does not |
|---|---|---|
| Failed reviews | A review that sends findings back | — |
| Unfinished turns | A turn that ends with no handback: a crash, a stall, a turn that ran out | An answered question |
| Stalls | A wait that exits 3 | — |

Reaching a limit stops the loop for the owner. So do these, whatever the counts:

- a session with a paid or live test, before it starts: say what it will spend;
- anything on the `owner_only` list, and any gate the plan names;
- a ruling that changes the design;
- the main branch has moved outside the plan; a fixture and the plan disagree in a way the precedence order does not settle; a spike contradicts a requirement;
- the machine is out of memory, or a process will not die.

The conductor does **not** stop for its own context size. The session compacts by itself, and `PROGRESS.md` plus the tags hold the state. After an accept it goes straight to the next session.

**The stop policy and the quality bar are separate things.** The owner may raise a limit ("I am back in four hours, allow six failed reviews"). Nobody lowers what counts as passing.

## What the owner sees

`handback/PROGRESS.md`, newest entry at the bottom, in plain language. Per session, five or six lines:

- the verdict, the merge commit, the counts (turns, questions, failed reviews);
- what exists now that did not, with one concrete example of a behaviour;
- what the review found, with one example of a breakage and what it would have meant;
- rulings the conductor made that the owner may overturn;
- what it changes for later sessions.

Standing instructions from the owner go at the top of the file, dated, with the line of the prompt each replaces.

When the loop stops for the owner: lead with why it stopped and the one thing needed, asked singly with the reason. Then what was done since the owner last looked and what comes next, with an example for anything not obvious.

## Rulings

The conductor is the plan's author between sessions. It may rule where the plan is silent or contradicts itself and the precedence order or the plan's evident intent settles it. Every ruling is written into the plan where the builder will read it, listed in the review, and named in `PROGRESS.md` as something the owner may overturn. A ruling is never made to get a failing session through.

## Things that go wrong, and what to do

- **The conductor's own session restarts** while a builder runs. The builder is detached and unaffected; the background wait died with the session. After any restart: `opencode_status` first, then start the wait again.
- **The builder crashes.** Its commits are intact. Continue the same run.
- **Memory is the real limit on a small machine.** One builder at a time; never the review subagent beside a running builder; at most the configured number of subagents. A mutation run that takes a minute alone can take twenty under memory pressure.
- **The builder leaves files outside the worktree** (scratch scripts in the system's temporary folder). If one of them is a generator the session's result depends on, keep a copy beside the handback and require it committed.
- **A clone at a deep path fails in ways that look like product bugs.** Keep review clones and worktrees at short paths.
- **A test written in one session carries that session's id or count as a literal** and cannot pass in a later one. The review of the first session should catch it; when it does not, the fix is a ruling, not a quiet edit.
- **The machine restarts between the merge and the tag.** The merge commit's content equals the reviewed commit; verify that, then tag.

## Cost

The conductor keeps itself small: it does not read whole area files. Reproduction, Read-line drafting and extraction go to subagents on a cheaper model. Rulings and the final judgement stay with the conductor.

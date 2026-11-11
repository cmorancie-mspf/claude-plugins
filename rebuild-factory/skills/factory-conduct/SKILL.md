---
name: factory-conduct
description: Stage 5 of the rebuild factory - the conductor loop. Drive a separate coding agent through the plan one session at a time via the oc-bridge tools - make the session ready, start the builder, answer its questions from the plan, review its work from a clean clone by breaking things on purpose, merge and tag on a pass, send findings back on a fail - and keep a plain-language progress log, stopping only for what the owner must decide. Use when someone says "/factory-conduct", "run the factory", "start the conductor", "resume the rebuild", "run the next session", "review session X", or pastes this in a fresh chat to continue after a stop.
---

# Factory conduct

You are the conductor: you drive the builder, you review each session, and you are the plan's author between sessions. The owner reads a log and is asked only for what only the owner can decide.

Automating the hand-offs must not weaken the review. You are faster than a person carrying messages between two agents. You are not allowed to be easier.

**Read these before the first session, and again after any restart of your own session:**

- `${CLAUDE_PLUGIN_ROOT}/references/conductor-loop.md`: the loop, the counts, when to stop, what goes wrong.
- `${CLAUDE_PLUGIN_ROOT}/references/review-protocol.md`: how a session is reviewed and how breakages are derived.

## Start, or resume

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" where` and the end of `handback/PROGRESS.md`. Read the standing instructions at the top of that file: they replace lines of this skill.
2. If a run exists for the next session, `opencode_status` it before anything else. If your own session was restarted, the background wait died with it: start it again.
3. Tell the owner in three lines where things stand and what you are about to do. Then begin; do not wait for a reply unless `where` reports a stop for the owner.

## The loop

One session at a time, in the order of `phases.json`. The helper agents run on the models named under `models` in `factory.config.json` (`session_reviewer`, `read_list_drafter`): pass each as the agent's model, and leave it out when the setting is empty. Start the builder with `thinking` as `builder.thinking` says.

| Step | Do | Tool |
|---|---|---|
| 1. Make ready | Fill the Read line (a `read-list-drafter` drafts, you check); rule on each gap in the block; write carried findings into the block; write the notes file; fill the prompt; create the worktree; install; log "made ready". | `factory.mjs prompt <session> --notes-file <f>` |
| 2. Build | Start the builder with the model and the deny-rules config from `factory.config.json`, then the wait command in the background. | `opencode_start` |
| 3. Read the handback | Blocked with a question: answer from the plan in the same run. No handback: recover the same run with a note of where it stopped. | `factory.mjs check-handback <session>`, `opencode_answer` |
| 4. Review | A fresh `session-reviewer` reproduces from a clean clone and breaks things on purpose; you judge its survivors and the builder's deviations. | Agent |
| 5a. Accept | Merge `--no-ff`, re-run the phase command on the merge, tag, write `REVIEW.md`, update the index, clean up, push if the policy says so, log, go on. | git |
| 5b. Send back | Findings to a file, then to the same run. Review again in full. Count it. | `opencode_answer` |

The notes for a session always tell the builder how its work will be attacked: a line that makes a decision is removed, a check it added is switched off, and a test must fail. A builder told this writes the assertions the first time.

## Judging a review

The reviewer reports facts; you give the verdict. For each surviving breakage, one of four: the session's own guard does not hold (send back); right behaviour no test holds (send back for the test, product untouched); a check a later session owns (carry it into that block, and its reviewer repeats the breakage); nothing observable changed (note it).

Never accept a session to keep the loop moving. Never rule on the plan to get a failing session through. Sending findings back is cheap; a gap under every later session is not.

## Stops

From `stop_policy` in the config: the limits on failed reviews, unfinished turns and stalls. An answered question does not count toward any of them.

Always: before a paid or live session; before anything on `owner_only`; at a gate the plan names; a ruling that changes the design; the main branch moved outside the plan; the machine is out of memory.

Never for your own context size. The log and the tags hold the state.

When you stop: why, and the one thing you need, asked singly with the reason. Then what was done and what comes next, with an example for anything not obvious.

## The log

`handback/PROGRESS.md`, after every session, in the shape of `${CLAUDE_PLUGIN_ROOT}/templates/progress.md`: the verdict and counts; what exists now, with one concrete behaviour; what the review found, with one example of what a survivor would have meant; rulings the owner may overturn; what changes for later sessions. Write it for someone who will not open the plan.

When the owner gives a standing instruction, write it at the top of the log, dated, with the line it replaces, and follow it from then on. Where it is a setting (a stop limit, auto-push, a model), also change it with `factory.mjs set`, so the next conductor reads it from the config.

## After the first session through the bridge

Treat it as the trial of the loop on this project. When it is accepted, write in the log what did not work as these instructions assumed, and adjust.

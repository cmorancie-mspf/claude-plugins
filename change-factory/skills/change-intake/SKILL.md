---
name: change-intake
description: Turn an owner's list of things to fix or build into a change-factory run - number the items, record the owner's decision on each, group them into streams, confirm each stream's tier and ship mode with the owner, open the run, have one brief-writer per stream write its brief in parallel, read every brief yourself, and put the briefs' decisions and questions to the owner before any worker starts. Use when someone says "/change-intake", "here is my list", "plan these changes", "turn this into workstreams", or "start a change run".
---

# Change intake

From the owner's list to briefs that are safe to hand to auto-approved workers. Read
`${CLAUDE_PLUGIN_ROOT}/references/method.md` first. Run the helper as the entry skill `change-factory` says.
The project must be set up and trusted (`doctor` says ready).

## 1. Items

Number every item of the owner's list (`I1`, `I2`, ...). For each, one line: what it is, and what you found in
the code when you looked (file:line). Read the code; do not plan from memory of it.

## 2. The owner's decisions

For each item ask only what changes what gets built: the behaviour, the scope, whether it ships on, off behind
a flag, or is research (a finding and a question, no code this run). Record the answers in your notes; they go
into the briefs.

## 3. Streams

Group items into streams so that streams own different files where possible (two streams that change the same
file will conflict at merge, and a resolved conflict makes the later stream red-team eligible). For each
stream propose a **tier** (high when a mistake reaches users, money, data or security; low for plumbing, docs,
retries) and a **ship mode**. Show the owner one table: stream, items, owned paths, tier, ship mode, and
whether it will get a red team. Ask also whether any stream should get a red team *before* its merge (it costs
one more strong-model pass, and the stream cannot merge until that red team says MERGEABLE). Step 4 records the
answer where the helper reads it.

## 4. Open the run

If the owner wants a red team before some streams' merges, record that first: the helper reads it from the
config. In `change-factory.config.json` set `roles.pre_merge_red_team` with those stream names, for example
`"pre_merge_red_team": { "via": "subagent", "model": "<the red team's model>", "fallback": ["<its fallback>"],
"on_fallback": "owed_pass", "streams": ["<s>"] }`; show it with `trust` and have the owner accept it with
`trust --yes`. Remove the names after the run.

`run open <run> --integration <integration branch> --session <id>` (an owner record: it sets the budgets, and
the canary spend at resume). It prints `base`: the commit every branch of the run starts from.

Create the integration branch and its worktree, and one branch and one worktree per stream (a research stream
needs none), all from that base, under the config's `worktree_root` (relative to the repository):

    git -C "<repository>" worktree add -b <integration branch> "<worktree_root>/integration" <base>
    git -C "<repository>" worktree add -b <stream branch> "<worktree_root>/<s>" <base>

`merge record`, `regenerate` and the combined test all need the integration worktree.

Then per stream `stream add <s> --title <t> --tier low|high --ship on|off|research`, and
`owner confirm <s> --tier <tier> --ship <ship mode>` (an owner record: the command names the tier and ship
mode so the owner sees what he approves; the helper refuses it when they differ from the stream).

## 5. Briefs, in parallel

A research stream gets a brief only when its item needs one to be understood; its work is the research step of
`change-run`. Every other stream gets one.

Start one `brief-writer` agent per stream in the same message, each with: the worktree path, the stream's
items and the owner's decisions, tier and ship mode, and the brief's path under `docs_paths` on the stream
branch. Record each dispatch first: `dispatch <s> --role brief_writer --expect <brief path>`; when an agent
returns, `result <dispatch> --outcome done --file <brief path>`.

## 6. Read every brief yourself

A brief is the prompt of an auto-approved worker. Read each one whole: the premise evidence (open the cited
lines), every item and its test, the owned paths, the off switch, and the worker rules. Fix what is wrong in
the brief and say so; never pass a brief you have not read.

Then `brief record <s> --file <brief>`. The helper refuses a brief without its sections, and puts the stream in
"needs owner" for a changed premise, a decision that changes what is built, or a question.

## 7. The owner's answers

Put every stream's decisions (marked yes) and questions to the owner in one message, grouped by stream. Record
each stream's answer with `owner answer <s> --text "<answer>"` (each asks the owner).

If an answer changes the brief, edit it first and then record it again, before `owner answer`: recording a
brief re-reads its lists. In the edited brief, write each answered question into the item it settles ("the
owner decided: ..."), and remove it from "Questions for the owner". Do not remark a decision as "no" to get
past the gate: the owner's answer is what clears it.

When no stream waits for the owner, go on with `change-run`.

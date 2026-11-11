# rebuild-factory: user guide

This guide is for the person who owns a codebase and wants it audited and rebuilt. It covers what you type, what happens, what you are asked for, and what to do when the loop stops. You do not need to read the plugin's other files to use it.

## What it is for

Use it on a codebase that exists, mostly works, and that you do not trust: the documents claim more than the code does, the tests pass without proving much, or an AI built it quickly and nobody checked.

It does three things, in order:

1. **Finds out what is true.** Independent reviewers audit the code and check the project's claims about itself.
2. **Writes a plan a cheaper model can build from.** Small sessions, each with tests whose expected values the plan owns.
3. **Runs the build.** A separate coding agent builds one session at a time. Each session is reproduced from a clean copy and attacked before it is merged.

The rule behind all of it: a builder's report proves nothing; only a test that fails when the code is wrong counts.

It is not for a new project with no code, and it is more than a one-file fix needs.

## Who does what

| Role | Who | Does |
|---|---|---|
| Owner | You | Decide direction, answer design questions, take the actions no agent may take |
| Conductor | A Claude Code chat | Plans, prepares each session, reviews, merges, keeps the log |
| Builder | OpenCode on a cheaper model | Writes the code and tests for one session, in its own folder |

You talk to the conductor. The conductor talks to the builder. You never copy text between them.

## Before you start

- **Claude Code**, with this plugin installed (below).
- **Node 20 or later**, and **git**.
- **OpenCode**, installed and signed in (see "Set up the builder" below). Only the build stage needs it; the audit, direction, plan and plan review run in Claude Code alone.
- **A git repository** with a clean working tree.
- **Free memory.** One builder, one conductor and a review use a few gigabytes. Close what you do not need. On a machine with 16 GB, memory is what limits the loop.

### Install, once per machine

```
claude plugin marketplace add <owner>/<repo>
claude plugin install rebuild-factory@mspf-factory
```

`<owner>/<repo>` is the plugin's repository on GitHub. If you were given the folder instead, put its path there.

Open a new Claude Code chat afterwards. Type `/mcp` and check that `oc-bridge` is listed: that is the part that drives the builder.

### Set up the builder, once per machine

The bridge starts OpenCode; it does not sign in for you and holds no credentials.

1. Install OpenCode.
2. Sign in to a provider: `opencode auth login`.
3. Find the exact model id: `opencode models`. Copy it into `builder.model` in the settings file when step 1 below asks for it.
4. Check it works, from any folder:

   ```
   opencode run -m <the model id> "Reply with only OK."
   ```

   If it prints OK, the bridge will work. A sign-in or quota error here is the error the builder would hit, and this is the cheap place to find it.

Use a model on a provider you pay for. Free tiers run out part-way through a session.

## The commands

Type each in a Claude Code chat opened on the repository. They run in this order.

### 1. `/rebuild-factory`: set up

Creates a folder called `factory-plan/` in the repository, keeps it out of git, and writes a settings file. It also tags the commit you are starting from.

It then asks for the settings one at a time, each with a recommendation. You can change any of them later with `/factory-config`.

**You are asked for:**

- the model the builder runs on;
- what no agent may ever do (the defaults: deploy, delete a deployed resource, touch a credential, spend money, use a second machine);
- how many failed reviews and unfinished builder turns a session may have before the loop waits for you (default six each);
- whether accepted work is pushed automatically (default no);
- which models the helper agents run on (default: the same as the chat).

### 2. `/factory-audit`: find out what is true

Four reviewers read the code independently, each through one lens: does it work, can it be attacked, do its claims match its code, is its shape right. A fifth then tries to disprove the serious findings, by running the failing path where that can be done safely.

**You are asked for:** what you most fear is wrong.

**You get:** `factory-plan/audit/AUDIT-REPORT.md`. It opens with a plain answer to "would you ship this?", then the findings, each numbered, with the file and line, what goes wrong and how sure the audit is.

**You may be asked to act:** if the audit finds a live credential or something running that should not be, it tells you, one item at a time, with the reason. Those actions are yours.

### 3. `/factory-direction`: decide

A short conversation. The audit says what is wrong; it does not say what to build.

**You are asked for:** what the system is for; what it owns and what belongs to other systems; what is kept, rebuilt, set aside or deleted; who uses it first; what is out of scope; which findings you accept as risks.

The conductor gives its own recommendation on each. Where you disagree, your answer stands.

**You get:** `factory-plan/direction/DECISIONS.md`.

### 4. `/factory-plan`: write the plan

**You are asked for:** very little.

**You get**, under `factory-plan/`:

- `plan/INDEX.md`: the short file that explains the whole plan. Read this one.
- `plan/areas/`: the design, with every requirement numbered.
- `plan/verification.md`: how each session is proven.
- `plan/phases.md`: the list of sessions and what each builds.
- `fixtures/`: the expected values, as data.
- `plan/traceability.md`: each audit finding and what answers it.

### 5. `/factory-plan-review`: test the plan

Six reviewers who did not write the plan try to build from it on paper. They report every place a builder would have to guess.

**Expect the first plan to be sent back.** That is the review working: a gap found here costs an edit, and the same gap found during the build costs a session. The conductor rules on each finding, rewrites the plan if needed, and runs a smaller second review.

**You are asked for:** the few questions that turn on a decision of yours.

**You get:** `factory-plan/plan-review/RULINGS.md` and a plan whose first sessions are ready.

### 6. `/factory-conduct`: build

Start this in a **fresh chat**, so the conductor is not carrying the audit and plan discussion.

For each session, the conductor:

1. **Makes it ready.** Works out exactly what the builder must read, settles any gap in the plan, and writes the builder's prompt.
2. **Starts the builder** in its own folder, and waits.
3. **Reads what the builder handed back.** If the builder asked a question the plan answers, the conductor answers it.
4. **Reviews.** A fresh reviewer copies the repository clean, runs the session's one deciding command, and compares the result with the builder's. Then it breaks things on purpose: it removes a line that makes a decision, or switches off a check, and expects a test to fail.
5. **Accepts or sends back.** On a pass it merges and tags. On a fail it sends the findings to the same builder and reviews again.

Then it goes straight to the next session.

## Following along

Open `factory-plan/handback/PROGRESS.md`. After every session the conductor adds a few lines in plain language: the verdict, what exists now that did not, what the review found, any ruling it made that you may overturn, and what changes for later sessions.

To see what the builder is doing at this moment, ask the conductor chat ("what is the builder doing?") or open the live log at `<your home folder>/.oc-bridge/runs/<project>-<session>/log.txt`.

To ask why the builder did something after a session, ask any Claude chat: "in the run for session X, why did the builder do Y?" It reads the log. If you want the builder's reasoning in the log as well as its actions, tell the conductor to start runs with thinking on.

## When the loop stops for you

It stops, and says why, in these cases:

| It stopped because | What it needs |
|---|---|
| The next session has a paid or live test | Your go-ahead, after it says what the test will spend |
| The next step is on your "no agent may" list | You to do it, with the commands it gives you |
| A question changes the design | Your decision |
| A session reached the limit of failed reviews or unfinished turns | Your call: continue, raise the limit, or look at the session yourself |
| The machine is out of memory, or a process will not stop | You to free memory or restart |
| The main branch changed outside the plan | You to say what happened |

It does not stop because its own chat has grown long.

**Changing the limits.** You can tell the conductor at any time, for example: "I am back in four hours; allow eight failed reviews before stopping." It records that at the top of the log. What you cannot change is what counts as passing: the review stays as strict.

**Overturning a ruling.** Tell the conductor which one. It corrects the plan and, if a merged session depended on it, schedules the fix as the first task of the next session.

## Resuming

After a stop, a restart, or a closed chat, open a chat on the repository and type `/factory-conduct`. It finds its place from the accepted tags and the log. A builder that was running when the chat closed keeps running; the conductor picks it up.

If you have lost track entirely, type `/rebuild-factory`. It tells you which stage you are at.

## What it costs

- **The plan stages cost the most thinking.** Use your strongest model for the audit, the plan and the first plan review.
- **The build costs time more than money.** As a guide: an hour of building, half an hour of review and twenty minutes of preparation per session, one after another. A rebuild of thirty sessions is days of mostly unattended running, not hours.
- **The builder is the cheap part**, which is why it is a separate, smaller model.

## Settings

You do not need to open a file. Type `/factory-config`, or just say what you want in any chat on the repository:

- "show me the settings"
- "build with <model>"
- "use opus for the plan reviewers"
- "allow eight failed reviews"
- "push after each accept"
- "show me the builder's thinking"
- "never let it send email"

It confirms each change with the old and the new value, and refuses a setting that does not exist.

The settings live in `factory-plan/factory.config.json`. The ones you are most likely to change:

| Setting | Meaning |
|---|---|
| `builder.model` | The model the builder runs on |
| `builder.config` | The builder's rules file: which commands it is refused |
| `stop_policy.failed_reviews` | Failed reviews of one session before the loop waits for you |
| `stop_policy.unfinished_turns` | Builder turns that end without a handback before it waits |
| `stop_policy.push_after_accept` | Whether accepted sessions are pushed automatically |
| `owner_only` | The actions no agent takes |
| `models.audit_reviewer`, `models.finding_verifier`, `models.plan_reviewer`, `models.session_reviewer`, `models.read_list_drafter` | Which model each helper agent runs on. Empty means the same model as the chat. |
| `builder.thinking` | Whether the builder's reasoning is written to its log |
| `limits.max_subagents` | How many helper agents may run at once; lower it on a small machine |

### Which model does what

| Part | Model | How you choose |
|---|---|---|
| The stage itself (the chat you type the command in) | That chat's model | `/model`, before you run the stage |
| The helper agents | The `models.*` settings; empty means the chat's model | `/factory-config` |
| The builder | `builder.model` | `/factory-config` |

A sensible split: your strongest model for the chats that run the audit, the plan and the plan review, and for the plan reviewers; a mid model for the session reviewer and the reading-list drafter; a cheap model for the builder.

`references/layout.md` in the plugin lists every setting and the whole folder.

## Safety, plainly

- The builder runs with its commands auto-approved; nobody watches each one. Its rules file refuses pushes and common deploy commands. **Edit that file for your project's own deploy commands before the first session.**
- The rules file matches command text. It stops the obvious and is not a sandbox. The clean-copy review is what catches the rest.
- Secrets found by the audit are reported by where they are, never printed. Rotating them is yours.
- Nothing is deployed by any stage.
- The plan folder is kept out of git by default, because an audit can name things that should not be published.

## When something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| The builder's run shows `failed` or `died` | Its process crashed, usually from low memory | Nothing is lost; the conductor continues the same builder session. Free memory. |
| The conductor chat restarted | The chat's process ended | Type `/factory-conduct`. The builder was not affected. |
| A session keeps failing review | The tests do not hold the behaviour, or the plan has a gap | Read the latest `REVIEW.md` in that session's handback folder; the findings are specific |
| The builder's turn keeps ending without a handback | It ran out of turn, often waiting on a background command | The conductor recovers it and tells it what is still owed; raise the limit if it is making progress |
| `oc-bridge` is not listed under `/mcp` | The plugin's bridge did not load | Reload the window; check Node is on the path |
| Odd failures in a review that the builder did not see | The review copy is at a long path | Set `worktree_root` to a short path |

## Words used here

- **Session**: one small piece of the build, done in one sitting, reviewed and merged before the next.
- **Phase command**: the one command that decides whether a session passes.
- **Fixture**: a data file of expected values that the plan owns and the builder may not edit.
- **Mutation**: a small defect put back into the code on purpose; a test must catch it.
- **Handback**: the builder's report at the end of a session.
- **Breakage**: a defect the reviewer introduces on purpose to see whether a test notices.
- **Ruling**: a decision the conductor makes where the plan is silent or contradicts itself; you may overturn it.
- **Spike**: a session that measures a fact and writes no product code.

## A note on maturity

The method was drawn from one rebuild that ran this way from audit to build. The helper script and the bridge are tested. The skills and agents have not yet been run on a second codebase, so expect to adjust them the first time, and change the plugin's reference files when you do, not your project.

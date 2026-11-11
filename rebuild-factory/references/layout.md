# The plan folder

Every stage reads and writes one folder, the plan folder. Its default place is `factory-plan/` at the root of the repository being rebuilt, kept out of git through `.git/info/exclude`. `factory.mjs init` creates it.

## Why it is not committed by default

- A review runs in a clean clone. If the plan is not in the clone, nothing the builder wrote can depend on it, and a test that only passes with the plan beside it fails where it should.
- The builder may read the plan and may not edit it. A folder outside the worktree makes that a fact: a worktree holds tracked files only.
- A plan often names things that must not be published: findings about live credentials, private repositories, the owner's machine.

Set `plan_committed` to true in the config only when the owner wants the plan in the repository. The review then compares the committed fixtures with the plan's copy as before, and the builder's prompt forbids edits under the plan folder.

## Layout

```
factory-plan/
  factory.config.json        the project's settings (see below)
  audit/
    AUDIT-REPORT.md          the findings, numbered, with the ship answer
    reviewers/<lens>.md      each reviewer's own report, written as it works
  direction/
    DECISIONS.md             what the owner decided, and what was left open
  plan/
    INDEX.md                 the short file every builder reads first
    areas/NN-<area>.md       the design, one file per area, every requirement numbered
    verification.md          the test design, the phase command, the handback format
    phases.md                the session map and one block per session
    phases.json              the session list as data (id, title, kind, paid, gate)
    traceability.md          each audit finding to its disposition
  fixtures/                  plan-owned test data the builder copies and may not edit
  plan-review/
    r<round>-<lens>.md       each plan reviewer's report
    RULINGS.md               the binding answers to what the reviews raised
  prompts/
    KICKOFF.md               the builder's prompt template, filled for this project
  handback/
    PROGRESS.md              the conductor's plain-language log
    <session>-PROMPT.md      the prompt one session was started with
    <session>/handback.md    what the builder handed back, with its summary files
    <session>/REVIEW.md      the review
```

## The config

`factory.config.json` is the only place a machine path, a model name or a command is written. Skills and prompts take them from it. It is changed with `factory.mjs set`, `add` and `remove` (the `factory-config` skill), which refuse an unknown key or a value of the wrong kind; `factory.mjs show` lists every setting with its meaning.

| Key | Meaning |
|---|---|
| `project` | The name used in prompts and logs. |
| `repo` | Absolute path of the main checkout. |
| `main_branch` | The branch accepted sessions are merged to. |
| `worktree_root` | Where session worktrees and review clones go. Keep it short: a deep path breaks tools on Windows. |
| `branch_prefix`, `tag_prefix` | A session `S` is built on `<branch_prefix>S` and accepted as `<tag_prefix>S`. |
| `builder.model`, `builder.config` | The model the builder runs on, and the builder tool's config file holding the deny rules. |
| `builder.thinking` | Whether the builder's reasoning is written to its log. |
| `models.*` | The model each helper agent runs on: `audit_reviewer`, `finding_verifier`, `plan_reviewer`, `session_reviewer`, `read_list_drafter`. Empty means the model of the chat that starts it. |
| `commands.install` | What a clean clone needs before anything runs, for example `npm ci`. |
| `commands.phase`, `commands.mutate` | The one command that decides a session, and the mutation run. `{session}` is replaced by the session id. |
| `stop_policy` | How many failed reviews, unfinished builder turns and stalls a session may have before the loop waits for the owner; whether the conductor pushes after an accept. |
| `owner_only` | Actions no agent takes. The builder's prompt and the conductor both carry this list. |
| `builder_must_not_read` | Paths the builder is told not to open, such as the audit and the rejected first plan. |

## Ids

Ids are how a finding is followed into a requirement, a test and a review. Choose the prefixes once and never renumber.

| Id | Form | Written in |
|---|---|---|
| Finding | `F-<lens letter>-<n>`, for example `F-S-4` | the audit |
| Requirement | `R<area letter>-<n>` | the area files |
| Acceptance test | `AT-<phase>.<n>` | `phases.md` |
| Mutation | `M-<phase>.<n>` | `verification.md` |
| Session | short and sortable, for example `2a-1`; a spike is `SP-<n>` | `phases.md`, `phases.json` |

A session id is also a branch name, a tag name and a run id, so it holds only letters, digits, `-` and `_`.

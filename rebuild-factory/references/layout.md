# The plan folder

Every stage reads and writes one folder, the plan folder. Its default place is `factory-plan/` at the root of the repository being rebuilt, kept out of git through `.git/info/exclude`. `factory.mjs init` creates it.

## Why it is not committed by default

- A review runs in a clean clone. If the plan is not in the clone, nothing the builder wrote can depend on it, and a test that only passes with the plan beside it fails where it should.
- The builder is told to read the plan and not to edit it, and is given one place to write: `handback/<session>/`. Keeping the folder outside the worktree means a builder does not change it by accident. It does not make changing it impossible: it is an ordinary folder the builder can write to. The conductor therefore records the folder before each builder turn (`factory.mjs seal`) and checks it afterwards (`check-seal`).
- A plan often names things that must not be published: findings about live credentials, private repositories, the owner's machine.

Set `plan_committed` to true in the config only when the owner wants the plan in the repository. The review then compares the committed fixtures with the plan's copy as before, and the builder's prompt forbids edits under the plan folder.

## Layout

```
factory-plan/
  factory.config.json        the project's settings (see below)
  builder-rules.json         the commands the builder is refused; edit it for the project
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
| `builder.model`, `builder.config` | The model the builder runs on, and the rules file: the builder tool's config holding the deny rules. `init` writes the project's own copy to `builder-rules.json` in the plan folder. It can never be empty. |
| `builder.thinking` | Whether the builder's reasoning is written to its log. |
| `models.*` | The model each helper agent runs on: `audit_reviewer`, `finding_verifier`, `plan_reviewer`, `session_reviewer`, `read_list_drafter`. Empty means the model of the chat that starts it. |
| `commands.install` | What a clean clone needs before anything runs, for example `npm ci`. |
| `commands.phase`, `commands.mutate` | The one command that decides a session, and the mutation run. `{session}` is replaced by the session id. |
| `stop_policy` | How many failed reviews, unfinished builder turns and stalls a session may have before the loop waits for the owner; whether the conductor pushes after an accept. |
| `owner_only` | Actions no agent takes. The builder's prompt and the conductor both carry this list. |
| `builder_must_not_read` | Paths the builder is told not to open, such as the audit and the rejected first plan. |

## Accepted on this machine

A plan folder's settings name commands that agents run, and its kickoff prompt is what a builder is told. So the helper script believes a plan folder only on a machine where `init` created it or the owner accepted it with `factory.mjs trust --yes`. The record is kept in the user's home folder (`~/.rebuild-factory`), keyed by the plan folder's real path; nothing in a repository or a plan folder can supply it. The settings must name the top folder of a real working repository by absolute path. A change to the commands, the rules file, the builder settings or the kickoff prompt that was not made through the script breaks the acceptance until the owner accepts again. `trust` prints what is being accepted: the commands, what the rules file refuses, the builder settings, the owner-only list, the stop policy, the project paragraph in full, any standing instructions in the log, and the kickoff prompt as the lines added to the plugin's template and the template lines taken out. It refuses a rules file that holds anything besides permissions, or whose shell rules are not a first `"*": "allow"` followed by denies only. It does not show the fixtures, the area files or the session blocks: those are the plan, and reading them is the plan review's job.

A session counts as accepted only when the conductor recorded it with `factory.mjs accept`, which requires an annotated tag on a merge commit on the main branch and a written review. The record is in the same home folder. A tag that was not recorded, or that is no longer the recorded one, is reported and ignored. The seal of the plan folder is kept there too.

These records are out of a clone's reach. They are not out of the builder's: it runs as the same user. The shipped rules refuse commands that name the folder or the helper script, which stops the easy path only.

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

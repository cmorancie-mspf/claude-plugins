---
name: change-release
description: Release a change-factory run - check it is releasable, ask the owner for each deploy unit separately with its rollback named first, record each deploy result, then check that main may move, and move main and push each on the owner's own yes; carry what is left to the next run. Use when someone says "/change-release", "deploy the run", "release the streams", "ship it", or the change-run loop has cleared its streams.
---

# Change release

Every deploy, the move of main and the push are the owner's own decisions, one at a time. You prepare the ask;
the owner says yes or no. Run the helper as the entry skill `change-factory` says.

## 1. Is it releasable?

`release-check`. Exit 1 lists what stops it: commits not accounted for, unreviewed fixes, regenerate not clean
at the head, combined suites without a pass, a stream that waits for the owner, a stream that ships ON without
a cleared red team or with an owed pass. Fix those through `change-run`. An owed pass is either paid (a pass on
the wanted model) or waived by the owner (`owner waive <s> --what owed --why "<reason>"`, an owner record:
with `hook_mode` deny, the default, they run it in their own terminal; with `ask` set, the hook asks them).

## 2. One ask per deploy unit

For each unit `release-check` prints, in its order, fill `${CLAUDE_PLUGIN_ROOT}/templates/deploy-ask.md` and put
it to the owner: the rollback first (with the current version if a lookup is configured), what it deploys,
each stream's off switch and where it is set, the time and the quiet window, the command, how to verify.
Ask for this unit only. A yes to one unit is not a yes to the next.

- `hook_mode` ask: on the owner's yes, run the unit's command; the guard asks the owner again at the prompt.
  That prompt is the yes that counts; do not word anything to make it a formality.
- `hook_mode` deny: the owner types the command himself with a leading `!`.
- A manual unit: the owner does it by hand and tells you the result.

Then, at once: `deploy record <unit> --result ok|failed [--rolled-back] [--verified ok|failed|skipped]`. If a
unit fails, say so, name the rollback, and ask before any next unit. A half-done release (one unit done,
another failed) shows in `status`.

## 3. Main and the push

`finish-check`. It refuses while main moved since the run's base (find out what landed first), or while a
unit that carries code has no `ok` (unless the owner records `owner merge-without <unit> --why "<reason>"`, an
owner record like the waiver).
Then, each on its own owner yes:

1. Move main: `git -C <main checkout> merge --ff-only <integration branch>`. The guard asks the owner.
2. Push: the configured push command. The guard asks the owner.

## 4. Carry and close

For every stream that ships OFF, every owed pass still open, every low finding not fixed, and every follow-up:
`carry add <s> --kind switch-on-condition|owed-pass|open-low|follow-up --text "<what>"`. A stream that ships
OFF is switched on later only after `owner switch-on <s>` passes (it refuses without a cleared red team).
If a paid owed pass later says CHANGES NEEDED on a stream that is already deployed, that is a carry item and an
owner question at once.

Then `run close`. The next `run open` in this project lists the open carry items first.

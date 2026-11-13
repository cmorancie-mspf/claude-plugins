# Release ask: <run>, unit <name>

Filled from `cf.mjs release-check`. One ask per deploy unit, in the order it prints. Each is the owner's own
yes; a yes to one unit is not a yes to the next, to moving main, or to the push.

**Rollback first:** <rollback, as configured> — current version: <output of the rollback lookup, or "not configured">

**What it deploys:** <streams whose merges touch this unit's paths>

**Off switches:** <for each stream in this unit: the setting and every place it must be set>

**Time:** <now, in the configured time zone> — quiet window: <output of the quiet-window command, or "judge the time">

**Command:** `<cmd>` — the guard asks you when it runs (hook_mode ask), or you type it yourself with `!`
(hook_mode deny). A manual unit: <what to do by hand>.

**Verify after:** `<verify>` (or "check by hand")

Then the conductor records the result: `deploy record <unit> --result ok|failed [--rolled-back] [--verified ok|failed|skipped]`.

---
name: factory-config
description: View and change a rebuild-factory project's settings in plain conversation, without opening the config file - the builder's model, which model each helper agent runs on, the stop limits, auto-push, what no agent may do, and the paths and commands. Use when someone says "/factory-config", "change the factory settings", "set the builder model", "use opus for the reviewers", "allow more failed reviews", "turn on push after accept", "turn on builder thinking", "show me the settings", or during first set-up of a project.
---

# Factory config

The owner should never have to edit `factory.config.json` by hand. This skill shows the settings in plain words and changes them through the helper script, which refuses an unknown key or a value of the wrong kind.

## Commands

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" show
node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" set <key> <value>
node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" add <key> <item>
node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" remove <key> <item>
```

`show` returns every setting with its value, its type and its meaning, and lists what is still empty. Never edit the file directly: the script is what keeps a typo from becoming a dead setting.

If there is no plan folder yet, run `factory.mjs init` first.

## When the owner asks to see the settings

Run `show` and present the settings grouped, in words, not as JSON:

- **The builder**: its model, its rules file, whether its reasoning is logged.
- **Helper models**: which model each helper agent runs on.
- **Stop limits**: failed reviews, unfinished turns, stalls, and whether accepted work is pushed.
- **No agent may**: the owner-only list.
- **Machine**: how many helpers at once; where worktrees go.
- **Commands**: install, phase, mutate.

Say what is still empty and at which stage each is needed.

## When the owner asks for a change

Translate what they said into the key, make the change, and confirm in one line with the old and new value.

| The owner says | Do |
|---|---|
| "build with <model>" | `set builder.model <id>`. If unsure of the id, run `opencode models` and match it. |
| "use opus for the plan reviewers", "cheap model for the session review" | `set models.<agent> <name>` |
| "reviewers on whatever this chat uses" | `set models.<agent> ""` |
| "allow eight failed reviews" | `set stop_policy.failed_reviews 8` |
| "push after each accept" | `set stop_policy.push_after_accept true` |
| "show me the builder's thinking" | `set builder.thinking true` (applies from the next run started) |
| "never let it send email" | `add owner_only "send email"` |
| "the machine is struggling" | `set limits.max_subagents 1` |

Two changes need a word of caution before you make them:

- **Removing an item from the owner-only list** hands that action to agents. Say what it allows and confirm.
- **`builder.config`** is the file that refuses pushes and deploys under auto-approve. Never clear it. If the owner points it at another file, read that file and say what it refuses.

A stop limit may be raised freely; it does not lower what counts as passing. If the conductor is running in another chat, tell the owner the change is read at the next session's start, and offer to note it at the top of `handback/PROGRESS.md` so the running conductor sees it.

## Helper models

Five helper agents, each with a setting under `models`. An empty value means "the same model as the chat that starts it".

| Setting | Helper | Suggested |
|---|---|---|
| `models.audit_reviewer` | The four audit reviewers | Strong. A missed finding is never planned for. |
| `models.finding_verifier` | Tries to disprove findings | Strong. |
| `models.plan_reviewer` | The plan reviewers | Strongest, for round 1. Mid for round 2. |
| `models.session_reviewer` | The clean-clone review | Mid. It follows a protocol; the conductor judges. |
| `models.read_list_drafter` | Drafts each reading list | Mid or cheap. The conductor checks it. |

The value is a model name the Agent tool accepts in this environment (for example `opus`, `sonnet`, `haiku`). The model of a stage's own chat is not a setting: the owner picks it with `/model` before running the stage. Suggest the strongest model for the audit, the plan and the plan review, and say so when a stage starts on a weaker one.

## First set-up

When called during set-up, ask for these one at a time, each with a recommendation, and set each as it is answered:

1. The builder's model. Have the owner run the check in the user guide if OpenCode has not been used on this machine.
2. What no agent may do: read out the default list; ask what to add.
3. The stop limits: the defaults are six failed reviews and six unfinished turns; ask when the owner expects to look in.
4. Whether to push after each accepted session.
5. The helper models, offered as one choice: "strong for the audit and plan review, mid for session reviews" or "everything on this chat's model".

Leave `commands.phase` and `commands.mutate` empty: the plan stage sets them.

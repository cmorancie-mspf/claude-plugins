---
name: factory-direction
description: Stage 2 of the rebuild factory. Turn an audit into the owner's direction - what the system is for, what it owns and does not own, what is kept, rebuilt or dropped, what is borrowed from other projects, and which risks are accepted - recorded as decisions the plan must follow. Use when someone says "/factory-direction", "what should we do with this codebase now", "what is the move after the audit", "decide what to keep and rebuild", or an audit has finished and no plan exists yet.
---

# Factory direction

An audit says what is wrong. It does not say what to build. This stage gets the decisions that only the owner can make, before a plan spends effort on the wrong system. It is a conversation, and it is short.

Reads `audit/AUDIT-REPORT.md`. Writes `direction/DECISIONS.md`.

## What to settle

Ask about these one at a time, each with your recommendation and the reason. Use the owner's own words for the answers.

1. **Purpose.** In one sentence, what is this system for, and for whom? The audit often shows a system doing three things; the owner picks which one it is.
2. **Boundary.** What does it own, and what belongs to something else? Name the neighbouring systems and write one line each on who decides what. Most confusion in a rebuild comes from two systems each thinking they own a decision.
3. **Disposition.** For each part the audit described: keep, rebuild, park (kept to read, never run), or delete. Default to rebuilding anything whose safety the audit could not show.
4. **Borrowing.** If related projects exist, look at them and say what transfers: usually patterns and vocabulary, rarely code. Record what is borrowed as an idea and what must not be copied (for example, source from a private repository into a public one).
5. **First user.** Who uses the rebuilt system first, and what must work for them? This sets where the session map can stop.
6. **Not now.** What is explicitly out of scope. Write it down so the plan does not grow it back.
7. **Accepted risks.** Findings the owner chooses to live with, each with what it costs and what would change the answer.
8. **Owner-only actions.** What no agent does: deploys, deletions, credentials, spend, pushes, a second machine. This becomes `owner_only` in the config.
9. **The builder.** Which tool and model builds, and what it may spend. This sets how small the sessions must be.

## How to run it

- Give your own view. The owner asked an architect, not a form. Where they disagree, their answer stands, and you say plainly what it costs.
- Check for the disagreement that matters most: who creates the work and who judges it. If this system executes work that something else defines or judges, say so in the boundary, because it decides half the design.
- Stop when a further question would not change the plan.

## The record

`direction/DECISIONS.md`: each decision numbered (`D-1` ...), one or two sentences, with the reason and, where it was contested, what was rejected. End with "Left open": questions deferred, and the session before which each must be answered.

Update `owner_only`, `builder.model` and `builder_must_not_read` in `factory.config.json` from the answers. Add the audit folder to `builder_must_not_read`: a builder that reads a description of the old system rebuilds the old system.

The next stage is `factory-plan`.

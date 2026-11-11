---
name: factory-plan
description: Stage 3 of the rebuild factory. Write the rebuild plan a weaker model can build from without its author - numbered requirements per area, a verification design with one phase command and mutation checks, plan-owned fixtures, small sessions with acceptance tests, spikes for unmeasured facts, a traceability table from every audit finding, and the builder's kickoff prompt. Use when someone says "/factory-plan", "write the rebuild plan", "write the plan a staff engineer would hand a junior", "turn the audit into a build plan", "split this into sessions", or the owner's direction is recorded and no plan exists.
---

# Factory plan

Write the plan. Its reader is a builder that is a weaker model than you, has none of your context, cannot ask a question while it works, and will do what the words say.

Reads `audit/AUDIT-REPORT.md` and `direction/DECISIONS.md`. Writes `plan/`, `fixtures/`, `prompts/`.

**Read these two files before writing anything. They are the standard the plan is reviewed against:**

- `${CLAUDE_PLUGIN_ROOT}/references/plan-standard.md`
- `${CLAUDE_PLUGIN_ROOT}/references/verification-standard.md`

## Order of work

1. **Vocabulary and rules first.** Fix the words (each state, role, object) and the rules of every session. Write them into `plan/INDEX.md` before any area file, and use them exactly afterwards. Most contradictions in a long plan are two words for one thing.
2. **Areas.** Cut the system into parts with one owner of each piece of state. One file per part under `plan/areas/`. Every requirement is one numbered sentence a test can show true or false. Put the reasoning next to the requirement.
3. **Verification design**, `plan/verification.md`: the layers, what stands in for the platform, the fixtures, the mutation list, the phase command and its summary, the handback format. Adapt the standard to the project's language; keep every role in it. Decide the two commands and write them into `factory.config.json` as `commands.phase` and `commands.mutate`, with `{session}`.
4. **Fixtures.** Every expected value that is a matter of design becomes a data file under `fixtures/`, with a manifest of hashes, a provenance note and a checker script.
5. **Sessions**, `plan/phases.md` and `plan/phases.json`. See below.
6. **Traceability**, `plan/traceability.md`: every audit finding id to the requirement, session or accepted risk that answers it.
7. **The builder's prompt.** Copy `${CLAUDE_PLUGIN_ROOT}/templates/kickoff-prompt.md` to `prompts/KICKOFF.md` and adjust it to the project. Write `prompts/PROJECT.md`: one paragraph on what is being built and why the rebuild is happening, written for the builder. These two files are part of what the owner accepts on this machine, so writing them makes the helper script refuse the plan folder until they are accepted: show the owner both, then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" trust --yes`.
8. **Finish the index**: the file map, which text wins, the do-not list, the session map with states, the owner's actions with the session each blocks, the accepted risks, and what is still open.

Long files are written by subagents working from the vocabulary and the decisions, one area each, with you checking the joins. Have each write to disk as it goes.

## Cutting the sessions

- **The first session makes the existing system safe**: stop what should not be running, remove false claims, park what is not being kept. It builds the smallest form of the phase command.
- **The next sessions build the checking machinery**: the full phase command, the static layer, the mutation tool, the harness and the platform stand-ins. They come before the product code they will judge.
- **Then the product, one seam per session**, each small enough for one sitting: about eight acceptance tests at most, one part of one area.
- **A spike before the first session that depends on an unmeasured fact.**
- **Mark paid or live tests and owner gates** in `phases.json` (`"paid": true`, `"gate": "..."`). The loop stops for them.
- If a phase needs several sessions, say what each one switches on, so a builder knows what does not exist yet.

`phases.json` is an ordered array: `{"id", "title", "kind": "build" | "spike", "paid", "gate"}`. The helper script and the conductor read it; keep it equal to the headings in `phases.md`.

Leave each session's `Read` line as "(to be filled before hand-over)" except the first two or three. The conductor fills each when it makes the session ready, because by then earlier sessions and rulings have changed what the block needs.

## Before calling it done

Run the checks at the end of `plan-standard.md` yourself and fix what they find: sessions too large; expected values that are adjectives; unmeasured facts; requirements with no session; unbounded reading; product code before its checks; anything that depends on the audit; owner actions with no session.

Then say plainly to the owner: this is a first plan, and its reviewers will probably send it back. The next stage is `factory-plan-review`.

# core

Shared code, edited here only. `node core/sync.mjs` copies each part into every plugin that carries it, as
listed in `consumers.json`; `node core/sync.mjs --check` (also run by `.github/check.mjs`) fails when a copy
differs. A plugin is installed from its own folder, which is why each carries a copy.

| Part | What | Carried by |
|---|---|---|
| `bridge/` | oc-bridge: starts, watches and stops non-interactive OpenCode runs; provider cap, end classification, environment scrub | rebuild-factory, change-factory |
| `lib/` | `store.mjs` (hashing, a lock, a hash-chained JSON-lines log), `rules.mjs` (checks of a worker rules file) | change-factory |

A change to `bridge/` changes every carrier's copy: bump each carrier's version and run its tests.

rebuild-factory keeps its own rules-sampling and trust code inside its `scripts/factory.mjs` for now; it moves
onto `lib/` in a later release with its own review. Until then the two versions are separate code that the
hash check does not compare.

Tests: `node core/tests/test_core.mjs` (sync, and the bridge with a stand-in for OpenCode; spends nothing).

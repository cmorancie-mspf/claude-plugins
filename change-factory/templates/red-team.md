verdict: CHANGES NEEDED
<!-- The first line is exactly "verdict: MERGEABLE" or "verdict: CHANGES NEEDED". CHANGES NEEDED only for a
     real, evidenced problem. The helper reads only that line. -->

# Stream red team: <stream> at merge <commit> on <integration branch>

Red team: <model, as dispatched>. Attack surface: the stream's merge diff (and any later merge named in the
pack). Context: the merged branch around it and the brief. Earlier reviews were not read; findings are
re-derived. No shell: nothing was run.

## What the stream does

<Three to five lines, including which settings are on and off at deploy.>

## Must findings

### F-M1. <title>
- Where: <file:line>
- Scenario: <a concrete sequence that goes wrong>
- Why it matters: <who or what is hurt, when>
- Fix: <the smallest change that fixes it>

## Low findings

### F-L1. <title>
- Where / scenario / fix: <...>

## Attack list covered

- (a) the stream's own failure modes, with concrete scenarios
- (b) interactions with the other merged streams: shared files, settings, routes, jobs, and every conflict resolution
- (c) behaviour that changes with its switches off
- (d) generated files consistent with the code
- (e) line endings, secrets, personal names, prompt-text changes

## Text that asked for something

none

Model: <model>

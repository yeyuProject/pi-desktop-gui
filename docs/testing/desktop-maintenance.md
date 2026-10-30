# Desktop maintenance validation

Date: 2026-10-30. Release: v0.14.60. Baseline: `dcd160582245dd8022f182d0305aaf1718941392` (v0.14.59).

## Changes checked

- Bridge fixtures save and restore inherited `PI_DESKTOP_*` variables; checkpoint cases opt in explicitly.
- JSONL records count raw bytes before concatenation and parsing. Complete records, split UTF-8, the final LF fragment, and recovery after an oversized record are covered.
- All 109 IPC policies were compared with the preceding implementation for six argument cases per method. Storage access, tracked operations, configuration serialization, dialog/update allowances and session reservations matched.
- Session, draft, agent and settings handlers retain the production behavior exercised by fault-injection tests. Agent operation queues, dialog timers and runtime serialization retain their existing regression coverage.
- Thirty-two Electron scripts and the plan UI helper use shared launch code. Startup failure and cleanup after Playwright disposes its application dispatcher have focused tests.

## Local results

Windows, Node.js 22.23.1, Electron 44.7.0:

- Build, TypeScript, lint, formatting and `git diff --check`: passed.
- Full unit suite with inherited `PI_DESKTOP_CHECKPOINTS=1` and `PI_DESKTOP_APPROVAL=readonly`: 773 passed, 8 skipped, 0 failed.
- Real Pi integration and feature suites against local model providers: passed.
- Thirty-one of the thirty-two migrated scripts: passed, including chat and plan UI, session switching, approvals, updates, model changes, Goal, both alternate appearances, runtime performance and the standalone rendering benchmark.
- The renderer bundle before and after the maintenance changes had identical SHA-256 hashes during the code regression run; no renderer source changes were made.

The Windows recovery UI script did not complete: `taskkill /T /F` returned an error while terminating the isolated test application's process tree. An untouched checkout of the baseline reproduced the same failure. The process-termination checks were not weakened to make this test pass.

An initial concurrent unit run exceeded the existing diff-worker time limit; the isolated full unit run passed. Initial clipboard and turn-outline hover checks also required an isolated chat run, which passed all chat, outline and plan checks. Assertions and business timeouts were retained.

These local checks precede the release version bump. The release workflow separately builds and checks the exact versioned commit and its platform artifacts; publishing additionally requires independent manifest signatures.

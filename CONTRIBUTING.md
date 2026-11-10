# Contributing

Small, focused bug fixes and clear reproductions are welcome. This is a self-hosted beta with deliberate bounds and review holds; do not silently relax those safeguards to make a test pass.

Read [architecture](docs/ARCHITECTURE.md) and [behaviour](docs/DECISIONS.md) first. Run `npm ci`, `npm run check`, `npm test`, `npm run build` and `npm run format:check`. Tests use local D1 and simulated provider APIs without live credentials. Preserve the installed toolchain unless a change needs an explicit upgrade.

For bugs, describe the source action, expected counterpart, actual outcome, timezone, recurrence rule and whether another integration writes the same objects. Use a synthetic example. Include redacted aggregate status when useful, not raw event/task bodies, private mapping files, OAuth URLs or database exports.

Add meaningful tests for write ordering, idempotency, conflict handling or provider behavior changes. Verify that completed Google history is untouched, retries can recognize already-applied writes, pages remain bounded, and held snapshots are not reset. Use the live acceptance checklist only with your own disposable calendar/project.

Document public functions and state transitions where the contract is not obvious. Comments should explain invariants, provider limitations or recovery intent rather than narrating each line. Never add credentials to CI. Do not enable paid plans, deployment workflows or automatic conflict resolution as incidental cleanup.

# Testing and acceptance

## Automated checks

```sh
npm ci
npm run types
npm run check
npm test
npm run build
npm run format:check
```

The suite includes normalization, authentication, snapshot decisions, timezone/DST handling, recurrence translation, local D1 integration, provider-write retries, tombstones, native conversion/splitting, ordered completions, reopening, mapped moves, CalDAV identity replacement, deletion evidence, held review and alert delivery. Provider HTTP APIs are simulated; no live credentials or mappings are needed. Fixtures are synthetic.

The public build uses only `wrangler.jsonc` and does not deploy or read personal deployment settings. CI runs these checks without production credentials. New configuration tests must verify that missing private files fail closed and that examples cannot silently select a real account.

## Live acceptance checklist

Start with an empty dedicated calendar and project. Use clearly named disposable items and an explicit mapping. Preserve before/after provider payloads privately when checking an invariant; never attach raw exports or callback URLs to an issue.

| Area                  | Check                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Creates/edits         | Timed and all-day items in both directions; title, notes, date and duration                                                            |
| Completion/reopening  | Google payload unchanged; recurring task advancement does not rewind Google's anchor                                                   |
| Native recurrence     | Daily/weekly and enabled monthly/yearly rules, including future rule changes and retained past instances                               |
| Google exceptions     | Finite/complex series, moved/renamed/cancelled instances and native-to-occurrence conversion retaining task identity                   |
| Todoist rolling rules | Native rule retained; next Google event created; rapid completions preserve intermediate events                                        |
| Undo                  | Existing Google history unchanged; known prior occurrence reactivated, parked next event reused where applicable                       |
| Moves                 | Both mapped directions, one projected occurrence, entire projected series, ID-replacing clients and delayed source cancellations       |
| Deletions             | Opt-in policies, completed tasks, current rolling event versus retained history, active-endpoint 404s, grace period and stale webhooks |
| Recovery              | Missed callbacks, expired sync cursor, paginated window entry, watch renewal, token rotation and lost write responses                  |
| Alerts                | Setup email reaches the operator, thresholds/cooldowns, uncertain delivery, recovery notice and private message content                |
| Operations            | Status/review correct, no unresolved failures, no unexpected duplicates and queues drained after tests                                 |

Only enable real mappings after these checks. Do not test destructive behavior against personal calendar data or rewrite another contributor's baselines.

## Evidence and limits

The implementation has been tested against live provider accounts during development, including finite Google occurrence tasks, individual exceptions, native schedule changes, retained completed history, rapid month-end advancement, CalDAV moves with replaced IDs, and email delivery. Personal IDs, titles, account resources and rollout logs are intentionally excluded from this repository.

Automated success does not guarantee real webhook delivery time, API compatibility across every account/locale, or free-tier capacity. This is a personal-use beta; large workloads and unavailable completion history need separate validation. Use the behavior and usage guides to understand what is intentionally bounded or held for review.

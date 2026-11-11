# Architecture and code guide

## Entry points

`src/index.ts` owns HTTP, scheduled and queue handlers. It serves generic public app/privacy pages, authenticates admin requests, validates Google channel identity and verifies Todoist webhook HMAC/account identity. Webhooks acknowledge only after durable enqueue; deduplication is recorded afterward so a crash can duplicate work but cannot silently discard it.

A single Queue consumer serializes writes and rotating-token refresh. Jobs carry identifiers/pagination state, not OAuth tokens. Exponential retry and provider Retry-After feed a dead-letter queue; failed-message records remain visible independently of unrelated successful work.

`processJob` in `src/sync.ts` obtains provider credentials, selects a mapping, and dispatches bounded work. A `true` result means the logical scan's last page completed; partial pages must not mark a full recovery scan healthy.

## Reconciliation

`Sync.event` and `Sync.task` resolve durable links and pending operations before deciding whether to import, reconcile or hold. `Sync.pair` normalizes live providers through `src/model.ts`, compares each with its own prior snapshot, and applies only the selected direction. Provider fields outside the synchronized surface are not replaced wholesale.

`src/model.ts` defines the canonical `Value` and queued job union. Unsupported normalization returns `null`, which must not become an empty/default event. `direction` implements snapshot comparison; `horizon` bounds new discovery without severing existing links.

## Durable states

| Record/state                                            | Purpose                                                                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `links.active`                                          | Current paired event/task with independent saved snapshots                                |
| `links.held`                                            | Pair requiring human review; ordinary scans do not reset baselines                        |
| `links.deleting` / `deleting_google`                    | Interrupted destructive action that must resume safely                                    |
| `links.deleted` / `moved`                               | Tombstones absorbing delayed notifications and preventing recreation                      |
| `links.history`, kinds `history` / `parked`             | Retained rolling occurrences without an active task, or future event retained during undo |
| `series.planning` / `converting` / `ready` / `deleting` | Journaled native-to-occurrence conversion and projection                                  |
| `operations`                                            | Stable move/split/detach request identity and recovery payload                            |
| `rolling_advances`                                      | Completion activity → deterministic next-event plan, committed once                       |
| `notification_health`                                   | Observed health stability and problem-email budget retained across recoveries             |
| `notifications`                                         | Delivery attempt, fingerprint, cooldown and uncertain/sent state                          |

Read migrations for exact schema; resource data is private, not fixture data for contributors. D1 batches commit related link/journal transitions together. Provider writes and D1 cannot form a distributed transaction, so each recovery path must recognize already-applied external writes.

## Recurrence and moves

`src/recurrence.ts` translates only equivalent native rules, performs timezone conversions, rejects ambiguous wall times and caches Intl formatters with a bounded cache.

The recurrence sections in `src/sync.ts` handle native future-rule splitting, conversion preserving task identity, provider-expanded occurrence pages, and ordered Todoist completion history. A completion must never move a Google native anchor or rewrite a historical rolling event.

`src/actions.ts` isolates cross-mapping moves and reverse deletion. `src/identity.ts` computes candidate copy identities for clients that replace IDs. Matching is deliberately constrained to recent unique copies; a similar title is not enough. Journals preserve destination identities across retries and lost continuation messages.

## Credentials and operational views

`src/api.ts` wraps bounded requests, redacted API errors, timing-safe secret checks and idempotent Todoist Sync commands. `src/tokens.ts` is the only rotating-token writer; invoke it only in the serialized queue consumer. Secrets Store propagation is verified in a separate invocation after rotation.

`src/monitoring.ts` exposes aggregate operational state. `src/review.ts` returns only selected historical title/date fields and bounded cursors. `src/notifications.ts` sends private operator notices with a delivery journal; it cannot independently monitor a total runtime outage.

`scripts/config.mjs` reads ignored JSONC/private mapping files. `scripts/wrangler.mjs` separates portable builds from personal deployments and uploads mapping secrets atomically. `scripts/authorize.mjs` handles localhost OAuth state validation and writes tokens directly to Cloudflare storage.

## Review invariants

1. Preserve Google on completion/reopening.
2. Read current counterparts before destructive writes; an ambiguous 404 is not cancellation evidence.
3. Persist an operation plan before a non-idempotent external write and keep request identities stable on retry.
4. Do not reset held snapshots or infer unrelated existing pairs by title.
5. Keep pages, candidate searches, formatter caches and activity recovery bounded.
6. Keep secrets out of D1, queue payloads, command arguments, source and logs.
7. Keep recovery checkpoints separate from rolling discovery; only a final page completes a scan.

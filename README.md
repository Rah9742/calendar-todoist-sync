# Calendar ↔ Todoist Sync

Personal, webhook-driven, two-way sync between multiple Google calendars and their mapped Todoist projects, designed for Cloudflare Workers and D1 on the free tier.

## Status

Repository scaffold only. No sync service is implemented or deployed, and no accounts are connected.

## Requirements

- Map each selected Google Calendar to a Todoist project.
- Sync creation and changes in both directions, targeting updates within seconds of webhook delivery.
- Keep stable event/task links and suppress duplicate notifications and update loops.
- Preserve completion so completed tasks are not recreated.
- Handle recurring occurrences, all-day events, and Europe/London daylight-saving changes.
- Renew Google notification channels and periodically reconcile missed notifications.
- Authenticate incoming webhooks and keep credentials out of source control and logs.
- Batch initial imports and recovery work to respect free-tier limits.

## Proposed implementation

TypeScript on Cloudflare Workers, D1 for mappings and sync state, and scheduled maintenance for notification renewal and recovery. A durable work queue may be used for retries and batching. GitHub Actions may run checks and deployment; it will not drive real-time syncing.

Calendar/project pairs are illustrated in `config/mappings.example.json`. Actual IDs will be selected during setup.

See `docs/SETUP.md` for required access and `docs/DECISIONS.md` for behaviour to resolve before live writes.

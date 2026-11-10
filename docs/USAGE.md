# Usage and free-tier budgeting

This project targets a small personal workload. It does not enroll you in a paid plan, verify your subscription, or guarantee that every deployment remains within free allowances.

Run `npm run usage` with Wrangler authenticated and private deployment configuration present. The command reads account Workers/Queue/D1 metrics, the configured queues' backlogs, database storage and Worker CPU cohorts. It does not create synthetic traffic or change a plan. Its analytics query stays inside a seven-day range: six complete UTC days plus the current partial day.

Reference daily allowances should be checked against the current official pricing: [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Queues](https://developers.cloudflare.com/queues/platform/pricing/) and [D1](https://developers.cloudflare.com/d1/platform/pricing/). Provider quotas and task/project limits are separate constraints.

Queue operations include delivery and deletion as well as enqueue. A successful job ordinarily costs several operations; retries, pagination, echoes, initial imports and occurrence expansion add more. Recovery runs every 15 minutes for incremental Google scans/watch maintenance and every six hours for full project/link/window scans. It still consumes budget when nothing changes.

The main consumer is serialized to protect token rotation and ordering. A manual reconcile or bulk import can temporarily delay newer webhook work. Inspect queue depths and oldest-message timestamps; free retention limits make recovery scans necessary. A zero-error metric does not exclude handled retries or work in the dead-letter queue.

D1 retains links, snapshots and tombstones; deletion of provider items does not purge historical state. Occurrence projection limits control per-scan/per-mapping work, not total long-term database size. Review retention and storage before expanding scope.

CPU cohorts are not an average workload guarantee. Do not average percentiles across event types/status groups or infer billing status from low request counts. Analytics may be sampled, delayed or revised. Check the account dashboard for the actual plan and [profile hotspots](PROFILING.md) before assuming headroom.

Status and email alerts complement provider/runtime diagnostics; they are not an independent external outage monitor. Keep raw diagnostics private because platform request metadata can include credentials even when application logs are redacted.

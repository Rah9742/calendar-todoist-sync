# Profiling

Use the installed Wrangler version and official [Workers profiling guidance](https://developers.cloudflare.com/workers/observability/cpu-profiling/). Profile the configured Worker deliberately; do not generate traffic against unrelated accounts or production calendars to obtain a sample.

Start with `npm run usage` to separate HTTP, queue and scheduled CPU cohorts. Then reproduce a representative normalization or reconciliation operation locally with synthetic data. The timezone formatter cache in `src/recurrence.ts` is bounded because Intl construction is expensive; preserve its timezone/DST correctness when optimizing.

A remote profiler can lack recent samples even when requests were observed. An unavailable profile is not evidence of low CPU cost. Report the exact verification limit rather than presenting a local microbenchmark as deployed free-tier headroom.

Do not put raw request logs or provider payloads in issues or commits. Capture only what is necessary, restrict file permissions, stop temporary capture when done, and retain sanitized summaries. Platform metadata can contain Authorization headers even when application logs do not.

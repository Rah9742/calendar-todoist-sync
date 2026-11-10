/** Read-only operational health plus durable per-message failure records. Unrelated successful jobs never clear old failures. */
import { ApiError } from "./api";
import { horizon, mappings, type Job } from "./model";

// Keep in step with queues.consumers.max_retries in wrangler.jsonc.
export const QUEUE_MAX_RETRIES = 8;
const operationalCodes = new Set([
  "completion_activity_pending",
  "pending_move_target_changed",
  "todoist_move_failed",
  "todoist_move_not_accepted",
  "todoist_command_failed",
  "todoist_mapping_missing",
  "token_store_propagation_pending",
  "configure_token_store",
  "invalid_refresh_response",
  "invalid_token_bundle",
  "token_storage_failed",
]);
export const failureCode = (error: unknown) =>
  error instanceof ApiError
    ? `upstream_${error.status}`
    : error instanceof Error && operationalCodes.has(error.message)
      ? error.message
      : "sync_failed";

/** Record page/final-scan success and acknowledge only this message's prior failure. */
export async function recordSuccess(
  env: Env,
  messageId: string,
  job: Job,
  completed: boolean,
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO job_status(mapping,kind,last_success,last_completed)
      VALUES(?,?,?,?) ON CONFLICT(mapping,kind) DO UPDATE SET
      last_success=excluded.last_success,
      last_completed=COALESCE(excluded.last_completed,job_status.last_completed)`,
    ).bind(job.mapping, job.kind, now, completed ? now : null),
    // A successful unrelated message must never hide a failed message.
    env.DB.prepare("DELETE FROM job_failures WHERE message_id=?").bind(
      messageId,
    ),
  ]);
}
/** Retain retry history by message identity so successful unrelated work cannot hide it. */
export async function recordFailure(
  env: Env,
  messageId: string,
  job: Job,
  error: unknown,
  attempts: number,
  delaySeconds: number,
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO job_failures
    (message_id,mapping,kind,code,attempts,first_failed,last_failed,retry_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET
    code=excluded.code,attempts=excluded.attempts,last_failed=excluded.last_failed,retry_at=excluded.retry_at`,
  )
    .bind(
      messageId,
      job.mapping,
      job.kind,
      failureCode(error),
      attempts,
      now,
      now,
      now + delaySeconds * 1000,
    )
    .run();
}

/** Build private aggregate health without making provider requests or returning source content/identifiers. */
export async function syncStatus(env: Env) {
  const now = Date.now();
  const retentionStart = now - 30 * 86400000;
  const [links, issues, channels, jobs, failures] = await env.DB.batch<
    Record<string, unknown>
  >([
    env.DB.prepare(
      "SELECT mapping,state,reason,COUNT(*) AS count FROM links GROUP BY mapping,state,reason",
    ),
    env.DB.prepare(
      "SELECT mapping,source,reason,COUNT(*) AS count FROM issues GROUP BY mapping,source,reason",
    ),
    env.DB.prepare(
      "SELECT mapping,MAX(expires) AS expires FROM channels WHERE resource_id IS NOT NULL GROUP BY mapping",
    ),
    env.DB.prepare(
      "SELECT mapping,kind,last_success,last_completed FROM job_status",
    ),
    env.DB.prepare(
      `SELECT mapping,kind,code,COUNT(*) AS count,MAX(attempts) AS max_attempts,
      SUM(CASE WHEN attempts>? THEN 1 ELSE 0 END) AS retry_limit_reached,
      MIN(first_failed) AS first_failed,MAX(last_failed) AS last_failed,
      MIN(CASE WHEN attempts<=? THEN retry_at ELSE NULL END) AS next_retry
      FROM job_failures WHERE last_failed>=? GROUP BY mapping,kind,code`,
    ).bind(QUEUE_MAX_RETRIES, QUEUE_MAX_RETRIES, retentionStart),
  ]);
  const iso = (value: unknown) =>
    typeof value === "number" ? new Date(value).toISOString() : null;
  const pairs = mappings(env).map((m) => {
    const own = (r: Record<string, unknown>) => r.mapping === m.id;
    const states = links.results
      .filter(own)
      .map(({ state, reason, count }) => ({ state, reason, count }));
    const review = issues.results
      .filter(own)
      .map(({ source, reason, count }) => ({ source, reason, count }));
    const expiration = Number(channels.results.find(own)?.expires || 0);
    const errors = failures.results.filter(own).map((r) => ({
      kind: r.kind,
      code: r.code,
      count: r.count,
      maxAttempts: r.max_attempts,
      retryLimitReached: r.retry_limit_reached,
      firstFailed: iso(r.first_failed),
      lastFailed: iso(r.last_failed),
      nextRetryAt: iso(r.next_retry),
    }));
    const recovery = (["google", "window", "tasks", "links"] as const).map(
      (kind) => {
        const row = jobs.results.find((r) => own(r) && r.kind === kind);
        return {
          kind,
          lastSuccessfulPage: iso(row?.last_success),
          lastCompletedScan: iso(row?.last_completed),
          stale:
            !row?.last_completed ||
            now - Number(row.last_completed) >
              (kind === "google" ? 45 * 60000 : 8 * 3600000),
        };
      },
    );
    const alerts: string[] = [];
    if (m.enabled !== false && env.SYNC_ENABLED === "true") {
      if (expiration <= now) alerts.push("google_watch_missing_or_expired");
      if (recovery.some((r) => r.stale))
        alerts.push("recovery_missing_or_stale");
    }
    if (errors.length) alerts.push("unresolved_job_failures");
    if (
      states.some((r) =>
        ["deleting", "deleting_google"].includes(String(r.state)),
      )
    )
      alerts.push("task_deletion_pending");
    if (states.some((r) => r.state === "held") || review.length)
      alerts.push("items_need_review");
    return {
      id: m.id,
      enabled: m.enabled !== false,
      alerts,
      googleWatchExpiresAt: expiration ? iso(expiration) : null,
      links: states,
      issues: review,
      recovery,
      failures: errors,
    };
  });
  const delivery = await env.DB.prepare(
    "SELECT state,attempted_at,sent_at FROM notifications ORDER BY attempted_at DESC LIMIT 1",
  ).first<{ state: string; attempted_at: number; sent_at: number | null }>();
  const enabled = env.SYNC_ENABLED === "true";
  return {
    generatedAt: new Date(now).toISOString(),
    enabled,
    status:
      !enabled || !pairs.some((p) => p.enabled)
        ? "paused"
        : pairs.some((p) => p.enabled && p.alerts.length)
          ? "attention"
          : "ok",
    window: horizon(env, now),
    failureRetentionDays: 30,
    email: {
      enabled: env.EMAIL_ALERTS === "true",
      deliveryState: delivery?.state || null,
      lastAttemptAt: iso(delivery?.attempted_at),
      lastSentAt: iso(delivery?.sent_at),
    },
    mappings: pairs,
    limitations: [
      "Scan timestamps record completed final pages, not an end-to-end latency guarantee.",
      "Queue depth, confirmed dead-letter delivery and platform failures before this handler runs are not measured here.",
      "A database outage can prevent status and failure recording; consult Cloudflare diagnostics if this endpoint fails.",
    ],
  };
}

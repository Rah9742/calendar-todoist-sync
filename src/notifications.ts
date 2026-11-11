/** Debounced operator alerts with a daily problem budget and durable delivery journaling. */
import { Buffer } from "node:buffer";
import { googleToken, json } from "./api";
import { syncStatus } from "./monitoring";
/** Send a setup, persistent-failure or recovery notice. Journal before Gmail delivery to bound duplicates after uncertain responses. */
export async function notify(
  env: Env,
  test = false,
  testId?: string,
): Promise<void> {
  if (env.EMAIL_ALERTS !== "true") return;
  const recipient = env.ALERT_EMAIL;
  const sender = env.ALERT_FROM || recipient;
  if (
    !recipient ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(
      sender,
    ) ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(
      recipient,
    )
  )
    throw new Error("configure_alert_email");
  const status = await syncStatus(env);
  const now = Date.now();
  const problems = status.mappings
    .filter((m) => m.enabled && m.alerts.length)
    .map((m) => ({
      mapping: m.id,
      reasons: m.alerts,
      failures: m.failures,
      holds: m.links.filter((l) => l.state === "held"),
      issues: m.issues,
    }));
  const fingerprint = JSON.stringify({ enabled: status.enabled, problems });
  const previous = await env.DB.prepare(
    "SELECT * FROM notifications WHERE id='email'",
  ).first<{
    fingerprint: string;
    state: string;
    attempted_at: number;
    sent_at: number | null;
  }>();
  if (!test) {
    // Observe health separately from delivery: a recovery must not reset the
    // daily problem budget, and changing counts must not restart a reminder.
    const condition = problems.length ? "problem" : "healthy";
    await env.DB.prepare(
      `INSERT INTO notification_health(id,condition,since,last_problem_at)
       VALUES('email',?,?,?) ON CONFLICT(id) DO UPDATE SET
       since=CASE WHEN notification_health.condition=excluded.condition THEN notification_health.since ELSE excluded.since END,
       condition=excluded.condition`,
    )
      .bind(condition, now, previous?.attempted_at ?? null)
      .run();
    const health = (await env.DB.prepare(
      "SELECT since,last_problem_at FROM notification_health WHERE id='email'",
    ).first<{ since: number; last_problem_at: number | null }>())!;
    const stable = now - health.since >= 30 * 60000;
    if (problems.length) {
      // Judge each failure's age; an unrelated old failure must not promote a
      // new retry. Other health conditions need consecutive observations.
      const persistent = problems.some((p) =>
        p.reasons.some((r) =>
          r === "unresolved_job_failures"
            ? p.failures.some(
                (f) =>
                  Number(f.retryLimitReached) > 0 ||
                  (f.firstFailed &&
                    now - Date.parse(f.firstFailed) >= 30 * 60000),
              )
            : stable,
        ),
      );
      if (!persistent) return;
      if (
        health.last_problem_at !== null &&
        now - health.last_problem_at < 86400000
      )
        return;
    } else {
      // Only close a successfully delivered problem alert, once health has
      // stayed clear for 30 minutes. Setup and uncertain sends cannot recover.
      if (!stable || previous?.state !== "sent") return;
      let deliveredProblem = false;
      try {
        deliveredProblem =
          JSON.parse(previous.fingerprint).problems?.length > 0;
      } catch {
        // Unknown legacy records are not evidence that a problem was delivered.
      }
      if (!deliveredProblem) return;
    }
  }
  const id = test ? `test-email:${testId || crypto.randomUUID()}` : "email";
  if (
    test &&
    (await env.DB.prepare("SELECT id FROM notifications WHERE id=?")
      .bind(id)
      .first())
  )
    return;
  const subject = test
    ? "Calendar–Todoist sync: email alerts ready"
    : problems.length
      ? "Calendar–Todoist sync needs attention"
      : "Calendar–Todoist sync has recovered";
  const reasonText: Record<string, string> = {
    unresolved_job_failures:
      "Some updates are still failing after automatic retries.",
    google_watch_missing_or_expired:
      "Google's live update subscription needs renewal.",
    recovery_missing_or_stale: "A background sync check is overdue.",
    task_deletion_pending: "A linked deletion has not finished yet.",
    items_need_review: "Some items need review before syncing can continue.",
  };
  const lines = test
    ? ["Email alerts are working. No action needed."]
    : problems.length
      ? problems.flatMap((p) => [
          `${p.mapping}: ${p.reasons.map((r) => reasonText[r] || "Sync needs review.").join(" ")}`,
          ...p.failures.map(
            (f) =>
              `  ${f.count} pending update(s)${typeof f.code === "string" && /^upstream_\d{3}$/.test(f.code) ? ` (provider HTTP ${f.code.slice(9)})` : ""}; ${Number(f.retryLimitReached) > 0 ? "retry limit reached — review needed" : "retrying automatically"}.`,
          ),
        ])
      : ["Sync is working again. No action needed."];
  const text = [
    subject,
    "",
    ...lines,
    "",
    "Checked: " +
      status.generatedAt.replace("T", " ").replace(/\.\d{3}Z$/, " UTC"),
    ...(problems.length && !test
      ? [
          "If this persists, run npm run status and npm run review in your sync installation.",
          "Further problem alerts are limited to one per 24 hours.",
        ]
      : []),
  ].join("\n");
  const escape = (s: string) =>
    s.replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]!,
    );
  const boundary = "sync-" + crypto.randomUUID();
  const mime = [
    `From: ${sender}`,
    `To: ${recipient}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    `Message-ID: <${crypto.randomUUID()}@${new URL(env.PUBLIC_URL).hostname}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(text).toString("base64"),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(`<pre>${escape(text)}</pre>`).toString("base64"),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  // Persist before sending. A lost HTTP response is recorded as uncertain, not
  // blindly retried; Gmail does not provide an exactly-once sending contract.
  const journal = env.DB.prepare(
    "INSERT INTO notifications(id,fingerprint,state,attempted_at) VALUES(?,?,'sending',?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,state='sending',attempted_at=excluded.attempted_at",
  ).bind(id, fingerprint, now);
  await env.DB.batch([
    journal,
    ...(!test && problems.length
      ? [
          env.DB.prepare(
            "UPDATE notification_health SET last_problem_at=? WHERE id='email'",
          ).bind(now),
        ]
      : []),
  ]);
  try {
    const sent = await json<{ id: string }>(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      await googleToken(env),
      {
        method: "POST",
        body: JSON.stringify({ raw: Buffer.from(mime).toString("base64url") }),
      },
    );
    await env.DB.prepare(
      "UPDATE notifications SET state='sent',sent_at=?,message_id=? WHERE id=?",
    )
      .bind(Date.now(), sent.id, id)
      .run();
  } catch (error) {
    await env.DB.prepare(
      "UPDATE notifications SET state='uncertain' WHERE id=?",
    )
      .bind(id)
      .run();
    throw error;
  }
}

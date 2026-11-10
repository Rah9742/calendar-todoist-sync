/** Private operator email with cooldown and delivery journaling. An uncertain Gmail response is not blindly retried. */
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
  if (
    !recipient ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(
      recipient,
    )
  )
    throw new Error("configure_alert_email");
  const status = await syncStatus(env);
  const problems = status.mappings
    .filter((m) => m.enabled && m.alerts.length)
    .map((m) => ({
      mapping: m.id,
      reasons: m.alerts,
      failures: m.failures.map((f) => ({ kind: f.kind, code: f.code })),
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
    if (!problems.length && (!previous || previous.fingerprint === fingerprint))
      return;
    // One daily reminder for unchanged problems; six-hour cooldown for changed
    // problems bounds duplicate sends after ambiguous delivery responses.
    const cooldown =
      previous?.fingerprint === fingerprint ? 86400000 : 6 * 3600000;
    const recovered =
      !problems.length &&
      previous?.state === "sent" &&
      previous.fingerprint !== fingerprint;
    if (previous && Date.now() - previous.attempted_at < cooldown && !recovered)
      return;
    const failing = await env.DB.prepare(
      "SELECT MIN(first_failed) AS first_failed FROM job_failures",
    ).first<{ first_failed: number | null }>();
    if (
      problems.length &&
      failing?.first_failed &&
      Date.now() - failing.first_failed < 15 * 60000 &&
      !problems.some((p) =>
        p.reasons.some((r) => r !== "unresolved_job_failures"),
      )
    )
      return;
  }
  const id = test ? `test-email:${testId || crypto.randomUUID()}` : "email";
  if (
    test &&
    (await env.DB.prepare("SELECT id FROM notifications WHERE id=?")
      .bind(id)
      .first())
  )
    return;
  const now = Date.now();
  const subject = test
    ? "Calendar–Todoist sync: email alerts ready"
    : problems.length
      ? "Calendar–Todoist sync needs attention"
      : "Calendar–Todoist sync has recovered";
  const lines = test
    ? [
        "This is the requested setup test for your private calendar–Todoist sync alerts.",
      ]
    : problems.length
      ? problems.map((p) => `${p.mapping}: ${p.reasons.join(", ")}`)
      : [
          "All configured mappings have current recovery scans and no unresolved sync issues.",
        ];
  const text = [
    subject,
    "",
    ...lines,
    "",
    "Checked: " + status.generatedAt,
    "Ask Codex to inspect the private sync status if action is needed.",
    "No task titles, event descriptions or credentials are included.",
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
    `From: ${recipient}`,
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
  await env.DB.prepare(
    "INSERT INTO notifications(id,fingerprint,state,attempted_at) VALUES(?,?,'sending',?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,state='sending',attempted_at=excluded.attempted_at",
  )
    .bind(id, fingerprint, now)
    .run();
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

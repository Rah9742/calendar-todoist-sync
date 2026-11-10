/** Generic public app/privacy pages. No installation identifiers or synchronized content are rendered. */
const shell = (title: string, content: string) => `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · calendar-todoist-sync</title>
<style>body{font:18px/1.6 system-ui,sans-serif;max-width:48rem;margin:4rem auto;padding:0 1.5rem;color:#17202a}a{color:#1756a9}h1,h2{line-height:1.2}footer{margin-top:3rem;font-size:.9rem}</style>
<main>${content}</main><footer><a href="/">About this app</a> · <a href="/privacy">Privacy policy</a></footer></html>`;
/** Serve generic informational HTML with restrictive security headers, or return undefined for unknown paths. */
export function informationPage(path: string): Response | undefined {
  let html: string;
  if (path === "/")
    html = shell(
      "About",
      `<h1>calendar-todoist-sync</h1>
<p>A personal integration that keeps selected Google calendars and Todoist projects in sync. It runs on Cloudflare Workers and uses provider webhooks to process changes.</p>
<p>It reads calendar events and scheduled tasks, then copies titles, descriptions and schedules between explicitly configured calendar/project pairs. Completing a task can retain its Google event unchanged. Supported recurring schedules use native recurrence on both sides.</p>
<p>This installation is operated for personal use. It has no public account registration or public view of calendar or task content. Authorization is performed by its operator through a local setup helper.</p>
<p>This independent integration is not created by, affiliated with, or supported by Google or Todoist.</p><p><a href="/privacy">Read the privacy policy</a> for details of data access, storage, sharing and removal.</p>`,
    );
  else if (path === "/privacy")
    html = shell(
      "Privacy policy",
      `<h1>Privacy policy</h1><p>Updated 10 November 2026. This policy describes this personal installation of calendar-todoist-sync.</p>
<h2>Data accessed and its purpose</h2><p>The integration uses Google Calendar permissions to read calendar lists and read or update event details. It uses Todoist authorization to read or update tasks in configured projects. It processes identifiers, titles, descriptions, dates, durations, recurrence and completion state to provide synchronization. Provider responses retained for recovery and move identification can also contain other event/task metadata, such as locations or attendee details.</p>
<p>When email alerts are enabled, the integration uses Gmail's send-only permission to send operational failure and recovery notices from the operator's account to the configured operator email address. It does not request Gmail mailbox-reading access. Alerts contain mapping names and failure categories, not task titles or event descriptions.</p>
<h2>Storage and sharing</h2><p>Google and Todoist receive the synchronized content in the operator-selected calendars and projects. Cloudflare processes the integration's requests and stores links, content snapshots, recovery payloads and operational state in D1. OAuth credentials are stored in Cloudflare Worker secrets or Secrets Store, separately from D1. Queues carry work identifiers and migration instructions, not OAuth credentials. Administrative endpoints require authentication.</p><p>Calendar and task content is not displayed on this public website. The integration does not sell user data, use it for advertising, or provide it for AI model training. Google user data is used only to provide the requested synchronization, subject to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including its Limited Use requirements.</p>
<h2>Retention and control</h2><p>Links and snapshots remain until the operator removes them. Deletion and conflict holds can retain snapshots to avoid accidental recreation or data loss. Webhook delivery deduplication records are removed after seven days; expired watch records are periodically removed. Cloudflare may retain operational request metadata and diagnostics under its configured logging retention. The application avoids deliberately logging credentials or event/task bodies.</p><p>Access can be revoked in Google account connections or Todoist integrations. Revoking access stops future authorized operations; it does not remove already copied tasks/events or stored snapshots. The operator can pause the Worker, remove its D1 data and secrets, and delete synchronized provider items as appropriate. Contact the operator using the support contact shown on the Google OAuth consent screen for questions or removal requests.</p>`,
    );
  else return;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

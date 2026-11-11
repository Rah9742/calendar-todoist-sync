# Setup

This is a self-hosted personal integration. Each installation needs its own Cloudflare resources and provider OAuth apps. Never paste credentials, OAuth callback URLs, database exports or private mappings into an issue or commit.

## 1. Create private local configuration

```sh
npm ci
npm run init:local
```

Edit `wrangler.local.jsonc`, `config/mappings.local.json` and `.dev.vars`. All three are ignored by Git; keep their permissions restricted. The initializer generates local admin/channel secrets and preserves any existing files. The checked-in Wrangler file is a template, not your deployment configuration.

Select a unique Worker name. Set `account_id` and `vars.CF_ACCOUNT_ID` to your Cloudflare account ID. Set `PUBLIC_URL` to its eventual HTTPS workers.dev URL. Keep `SYNC_ENABLED=false` throughout setup. Choose names for the D1 database, main queue, dead-letter queue and token-store secret. Use those same names in every relevant binding.

Run `npx wrangler login` and `npx wrangler whoami` locally. Verify the intended account. Do not enable a paid plan as part of this setup.

## 2. Provision Cloudflare resources

With your actual account selected in the private Wrangler file:

```sh
npm run cf -- d1 create calendar-todoist-sync
npm run cf -- queues create calendar-todoist-sync
npm run cf -- queues create calendar-todoist-sync-dlq
npm run cf -- secrets-store store create calendar-todoist-sync --remote
```

Use your chosen names if different. Copy the returned D1 ID into `d1_databases[].database_id`. Copy the store ID into both the Secrets Store binding and `vars.TOKEN_STORE_ID`.

Create a dedicated token-bundle secret:

```sh
npm run cf -- secrets-store secret create YOUR_STORE_ID --name calendar-todoist-sync-tokens --scopes workers --remote
```

Enter `{}` at the secret-value prompt for this **new** entry. Copy its ID into `vars.TODOIST_TOKEN_SECRET_ID` and its name into the binding. Never overwrite an existing populated token entry with `{}`. Todoist authorization will populate the new entry later.

Apply D1 migrations:

```sh
npm run cf -- d1 migrations apply DB --remote
```

Create an account-scoped Cloudflare API token with Secrets Store Write/Edit permission, restricted to this account. Save it directly as `CF_SECRET_STORE_TOKEN` in `.dev.vars`. This permits unattended Todoist refresh-token rotation. Do not use an unrestricted global API key.

## 3. Create a dedicated test pair

Create an empty Google calendar and an empty Todoist project for acceptance testing. You need write access to both.

Google exposes the calendar ID under **Calendar settings → Integrate calendar**. For Todoist, obtain the project ID from its project link or the authorized [API project listing](https://developer.todoist.com/api/v1/); use the current API ID, not a title or an invented numeric conversion.

Put only that pair in `config/mappings.local.json` to start. The file has the same shape as `config/mappings.example.json`. `id` is your stable internal name; calendar/project endpoints must be unique. It must contain at least one pair. Feature flags are per pair:

| Flag                               | Effect                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `enabled:false`                    | Exclude the pair from normal webhook and scheduled processing                             |
| `extendedRecurrence:true`          | Enable equivalent fixed-day monthly/yearly native rules                                   |
| `complexRecurrence:true`           | Enable occurrence projection, native schedule edits and unsupported Todoist rolling rules |
| `mappedMoves:true`                 | Propagate moves between pairs where both ends opt in                                      |
| `deleteTasksOnGoogleDeletion:true` | Delete linked Todoist tasks after confirmed Google cancellation                           |
| `deleteGoogleOnTaskDeletion:true`  | Delete the current linked Google counterpart after confirmed task deletion                |

Start with destructive flags off. Keep `COMPLETION_MODE=retain` to leave Google unchanged on completion/reopening. The rolling import horizon is controlled by `HORIZON_DAYS` (default 90); its day boundary is currently Europe/London in code.

Deploy a paused bootstrap to make the public app/privacy pages and webhook URLs available before authorization:

```sh
npm run deploy -- --bootstrap
```

This forces the deployed Worker to paused mode without changing the local switch. The normal deploy uploads mappings as a Worker secret in the same version as the code. Temporary secret-upload JSON is owner-only and deleted afterward; omitted provider secrets are preserved.

## 4. Register and authorize Google

1. Create a Google Cloud project and enable the Calendar API.
2. Configure Google Auth Platform branding, support contact, Audience and data-access scopes. Use your deployed app homepage and `/privacy` URL.
3. Register an OAuth **web application** client with redirect URI `http://localhost:8788/oauth/google/callback`.
4. Save its client ID and client secret directly in `.dev.vars` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. Add your account as a test user while the app is in Testing, then run:

   ```sh
   npm run authorize:google
   ```

The helper requests Calendar event access, calendar-list read access and offline authorization. Consent happens in your browser; the refresh token is saved directly in Cloudflare secret storage. The helper currently uses macOS `open`. Do not copy the authorization URL or callback into a public issue.

External Google apps in Testing can have short-lived refresh authorization. For unattended personal use, review Google's current [token-expiry rules](https://developers.google.com/identity/protocols/oauth2#expiration) and app publishing/verification requirements. Production publication and public verification are different. This project does not bypass provider consent or verification requirements.

Optional alerts require Gmail API and the additional `gmail.send` scope. Set `EMAIL_ALERTS=true`, configure your private `ALERT_EMAIL` (recipient) and `ALERT_FROM` (the authorized Gmail sender), then run `node scripts/authorize.mjs google --email`. No mailbox-reading permission is requested. Complete provider security/consent screens yourself where required.

For filtering, the recipient can be a Gmail plus alias such as `you+todoist@gmail.com`; keep `ALERT_FROM=you@gmail.com`. No separate plus-address account is needed. Alerts use basic mapping/status summaries, with a 30-minute persistence window and at most one problem email per 24 hours. A recovery email requires 30 minutes of clear status. Before deploying upgrades, apply the D1 migrations, including `0008_notification_health.sql`, so the debounce and daily budget survive restarts.

## 5. Register and authorize Todoist

1. Create an app in [Todoist App Management Console](https://app.todoist.com/appconsole/).
2. Set redirect URI `http://localhost:8788/oauth/todoist/callback`.
3. Set webhook callback to `YOUR_PUBLIC_URL/webhooks/todoist`.
4. Subscribe to `item:added`, `item:updated`, `item:deleted`, `item:completed` and `item:uncompleted` using a supported current webhook version.
5. Save `TODOIST_CLIENT_ID` and `TODOIST_CLIENT_SECRET` directly in `.dev.vars`.
6. Run `npm run authorize:todoist` and complete consent.

The helper populates the token store and writes the app credentials, user allowlist ID and restricted rotation token to Worker secrets. It requests read/write access and requests delete access when Google-to-Todoist deletion is enabled. Reauthorize if you enable a policy needing additional scope. A personal API token alone does not activate the app's webhooks.

Only one serialized consumer may refresh this token bundle. Pause processing before Todoist reauthorization, and never share its rotating credential between two active Workers. Refresh and secret persistence cannot be atomic across providers; failed persistence can require reauthorization. See [architecture](ARCHITECTURE.md).

## 6. Enable and validate the test pair

Confirm all resource IDs, mappings, callback URLs and secrets. Set `SYNC_ENABLED=true` in **the private** Wrangler file:

```sh
npm run deploy
npm run status
```

Run `npm run reconcile` once to initialize watches and recovery. It reads the local admin secret in memory and sends it in a header, never in a command argument or URL. Subsequent scheduled jobs renew watches automatically. The equivalent protected API is `POST /admin/reconcile`.

Follow [TESTING.md](TESTING.md): test both directions, completion/reopening, recurrence, timezone boundaries and retries. Enable deletion/move flags only after confirming the behavior with disposable items. Optional `POST /admin/test-email` sends one setup message to the configured operator; `/admin/notify` performs an ordinary threshold/cooldown-aware status check. Both require the same admin header.

## 7. Add real mappings

Add one pair at a time to the ignored mapping file, then deploy. Existing unlinked items inside the rolling window are eligible for import, so inspect for duplicates first. An existing item is never safely identified by title alone. For reviewed pre-existing counterparts, see [MIGRATION.md](MIGRATION.md).

Disable old integrations that write the same items. A display-only provider calendar view can remain enabled; it may show an event beside a real synced task.

To retire a pair, remove it from the mapping file (or set `enabled:false`) and deploy **before** deleting its calendars/projects. Retired mappings are not scanned or matched by webhooks; already queued jobs cannot perform writes through a removed mapping. Stored historical links are not purged automatically. Keep at least one pair in the file, or pause the Worker before retiring the last one.

## Maintenance

`npm run status`, `npm run review` and `npm run usage` read your ignored private deployment settings. They never change provider data. Keep status output and database exports private: review output can contain saved titles/dates. `npm run cf -- <command>` uses your local deployment, while `npm run build` always builds the portable public template.

Do not reset held snapshots to release conflicts. Read both live counterparts and resolve deliberately. Keep backups separately from synchronization. Monitor queues, token rotation, watch expiry and actual resource use; email alerts cannot independently detect failure of their own runtime or Google credential.

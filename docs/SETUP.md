# Access and setup

Do not paste passwords, API tokens, OAuth client secrets, refresh tokens, or downloaded credential files into chat or Git. Store runtime secrets using Cloudflare secret storage; use an ignored local file only for development.

## Cloudflare

- A Cloudflare account on the Workers Free plan.
- Authorize the deployment CLI locally through browser login, or provide a narrowly scoped API token through a local secret mechanism.
- Deployment needs permission to create/update this Worker, create/use its D1 database, configure its routes/triggers and secrets, and optionally create/use a queue.
- No domain purchase is required; use the provided workers.dev HTTPS endpoint.
- Final permissions and bindings will be documented with the implementation. No Cloudflare access has been granted yet.

## Google Calendar

- A Google Cloud project with Calendar API enabled.
- OAuth consent configured and a web application OAuth client with the deployed callback URL.
- User authorization for calendar discovery and event read/write access on selected calendars. No Gmail email access is needed.
- Offline authorization so the service can refresh tokens while the user is absent.
- The account must have write access to calendars receiving updates.
- For an external app, resolve Testing status before ongoing use: Calendar refresh tokens issued in Testing generally expire after seven days. Production status and verification are separate; personal-use requirements must be checked during setup.
- No Google password, service-account key, or domain-wide delegation is required.

## Todoist

- Register a developer integration with the deployed OAuth redirect and webhook URLs.
- Complete OAuth for the user's own Todoist account to activate webhooks; a personal API token alone is not sufficient for that activation.
- Authorize the project/task read and write capabilities needed for sync. Final scope selection will follow implementation needs.
- Store the integration client secret and issued access token as secrets.
- The user must have permission to edit the mapped projects.

## GitHub (optional for local development)

- This repository starts locally. A remote repository has not been created.
- A private GitHub repository is recommended for configuration and deployment work.
- To create/push the remote, authorize the GitHub CLI or connector for that repository.
- Automated deployment will need a restricted Cloudflare deployment credential in GitHub Actions secrets.

## Information needed from the user

- Which Google calendar maps to which Todoist project (names initially; exact IDs via authorized discovery).
- Desired completion, deletion, recurring-event, and task-without-date behaviour; see DECISIONS.md.
- Existing native Todoist calendar sync and TaskCalSync connections, so migration can avoid duplicate writers and loops.

## Validation before broad rollout

Start with a dedicated test calendar and project. Check creation/edit/completion/deletion in both directions, duplicates, concurrent changes, recurring exceptions, time zones, retries, channel renewal, recovery, and actual CPU/usage measurements. Enable real mappings only after these checks.

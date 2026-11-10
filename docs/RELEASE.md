# Release checklist

Use this before sharing an installation or a new version publicly. A passing test suite is not proof that private files or configuration are absent from Git history.

## Validate the publishable repository

1. Use a clean checkout without private configuration or credentials. Run `npm ci`, `npm run check`, `npm test`, `npm run build` and `npm run format:check`.
2. Run `npm run privacy:check` locally, where it can also compare against your known private installation values. Run an independent offline secret scanner against the staged diff and published branch/tag history with redaction enabled.
3. Inspect the actual uploaded tree and remote refs. Publish selected branches/tags, never a mirror push or a raw `.git` directory. Private IDE snapshot refs are not release content.
4. Verify that `.dev.vars`, private Wrangler/mapping files, exports, logs, credentials and personal rollout reports are excluded. Examples must contain placeholders, not an operator's real IDs or deployed URLs.
5. Confirm GitHub CI completed successfully for the exact commit being released. The workflow needs no production credentials and must not deploy a live installation.

## Make publication choices deliberately

- The repository owner chooses the licence and public/private visibility. A private preparation repository is not yet a public release.
- Add the approved licence before creating a release tag so the tagged source includes it. Do not imply that unlicensed source grants permission to reuse it.
- Review the README's beta status, supported behavior, setup prerequisites and limits. Avoid promising guaranteed latency, zero cost at every workload or support for every recurrence pattern.
- After approval, publish the selected commit/tag and verify the public repository and documentation links. Enable private vulnerability reporting if supported.

## Prepare an announcement

Explain who the project is for, what it does, what setup it requires and what is still bounded or requires review. Disclose that users need their own Cloudflare resources and Google/Todoist OAuth apps. Link to setup, behavior, security and testing documentation.

Use synthetic examples. Do not post personal calendar screenshots, task titles, account/resource IDs, callback URLs or private status output. Respect the target community's posting rules. Preparing a draft does not authorize posting it.

## Keep the running installation separate

Publishing source does not redeploy your Worker. Local mappings and credentials remain separate. Retire mappings before deleting their provider calendars/projects, and validate any new behavior with a fresh disposable test pair before changing real data.

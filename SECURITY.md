# Security

Do not publish a vulnerability together with credentials or personal calendar data. Use GitHub's private vulnerability reporting when available; otherwise open a minimal issue asking for a private reporting channel without including sensitive details.

## Keep local installation data private

- Never commit `.dev.vars`, `.env`, `wrangler.local.jsonc`, private mapping JSON, token bundles, OAuth downloads, database exports or raw platform logs.
- The checked-in Wrangler configuration contains placeholders. Live commands use a separately ignored local configuration; mappings are uploaded as a Worker secret.
- OAuth credentials live in Worker secrets / Secrets Store. D1 contains private content snapshots and recovery metadata, not OAuth tokens. Treat D1 backups as sensitive user data.
- Administrative tokens belong in Authorization headers, never query strings. Review output can contain historical task/event titles.
- Token rotation must have exactly one serialized writer. Do not share the same rotating token bundle across Workers.
- Use your own provider OAuth apps and narrow Cloudflare permissions. Never use the maintainer's app or copy another installation's credentials.

## Before publishing a fork

Audit the files **and published branch/tag commit history**. Local IDE tooling may retain private worktree snapshots under non-branch refs; never publish a raw `.git` directory or use a mirror push. `.gitignore` does not remove an already committed secret. Run a reputable secret scanner with redaction enabled, inspect configuration/docs for personal identifiers, and check the staged diff. If a real credential was committed, revoke/rotate it; merely deleting the file in a later commit is insufficient.

No scanner proves that a repository is free of every sensitive string. Examples and bug reports should use invented IDs and synthetic events. Never upload real credentials to an online scanner.

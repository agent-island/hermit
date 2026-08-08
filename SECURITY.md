# Security

Do not publish `.env`, `data/`, `link/`, or `archive/`. They may contain API keys, model configuration, browser sessions, workspaces, letters, and complete life records. The repository ignores these paths, but the ignore file is not a substitute for checking the staged files before a release.

The observer binds to `127.0.0.1` by default. Do not expose it to an untrusted network: its control routes can alter a run, write observer messages, and reveal the record. Browser search can open arbitrary web pages, and model prompts and search queries leave the machine for the configured providers. Use a dedicated browser profile and accounts with minimal privileges.

`email()` is not an email transport. It writes a local JSON record under `link/letters.json` unless `AMI_MAIL_FILE` is set. Adding SMTP, mailbox credentials, or automatic delivery is outside the current security boundary and must not be presented as an existing feature.

For a private vulnerability report, contact the repository owner through the hosting platform's private security-reporting channel. Do not include real credentials or private life records in a public issue.


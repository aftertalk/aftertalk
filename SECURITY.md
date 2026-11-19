# Security policy

Aftertalk processes call recordings, which hold personal data. Please report
security problems privately, not in a public issue.

## Reporting a vulnerability

Use GitHub's private reporting: open the **Security** tab of this repository
and choose **Report a vulnerability**. Only the maintainers see the report.

Include what you found, how to reproduce it, and which version or commit you
tested. We aim to answer within 5 working days and to agree on a disclosure
date with you before anything is published.

## Supported versions

Aftertalk has no release yet. Until the first release, fixes go to `main`
only. After it, the latest release gets security fixes.

## Scope

In scope: the web app (`apps/web`), the engine (`packages/engine`), the
Docker images and compose files in this repository.

Out of scope: speech, diarization and LLM providers you connect, and the
server and network you run Aftertalk on. See `docs/` (coming with the first
release) for how to deploy it safely.

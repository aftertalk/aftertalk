# Aftertalk

Self-hosted call analysis for support and contact-centre teams: upload a
recording, get a transcript with personal data redacted, a summary, a call
reason and a scorecard, with every quote located in the transcript.

Status: pre-release. Nothing here is runnable yet.

## Layout (monorepo)

```
apps/web/         Next.js app: UI, login, all database work, job queue
packages/engine/  Python engine: stateless processing over HTTP
docker/           Dockerfiles and compose examples
docs/             Self-hosting and privacy docs
samples/          Consented sample calls
tests/            End-to-end tests and fake providers
```

Commercial features live in a separate private repository that merges this
one. Code for them goes only under `apps/web/ee/` and `apps/web/app/(ee)/`.

## License

AGPL-3.0. Outside pull requests are not accepted until a contributor licence
agreement is in place.

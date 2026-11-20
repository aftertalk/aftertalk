## Summary

<!-- One or two sentences: what changes and why. -->

**Spec:** <!-- plan items and decisions, e.g. "items 20-29, #64", or "none" -->

## Changes

<!-- Grouped by area (web, engine, docker, docs). One line each; link the main files. -->

## Checks

- [ ] Web: `pnpm --filter web lint && pnpm --filter web typecheck && pnpm --filter web format:check && pnpm --filter web test`
- [ ] Engine (if it changed): `uv run --project apps/engine ruff check apps/engine`, `ruff format --check` and `pytest` the same way (commands in `CLAUDE.md`)
- [ ] Tried by hand: <!-- what you ran and saw, or "not needed" -->
- [ ] Security and general review done, findings fixed in this PR

CI also runs `next build` and the full stack with `docker compose -f docker-compose.dev.yml up --wait`.

## Rules this PR keeps (selected from `CLAUDE.md`)

- [ ] The engine contract, `openapi.json` and the Orval client change together (or the contract is untouched)
- [ ] No commercial code; no edits to the `apps/web/ee/` stubs or `apps/web/app/(ee)/`
- [ ] Logs only through `lib/log.ts` / `logging.py`; no transcript text, keys or personal data
- [ ] English first; Polish strings added for any new UI text (#90)
- [ ] No AI `Co-Authored-By` lines or "Generated with" footers

## Not in this PR

<!-- Known gaps and follow-ups, or "nothing". -->

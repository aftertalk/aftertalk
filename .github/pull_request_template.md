## Summary

<!-- One or two sentences: what changes and why. -->

**Spec:** <!-- plan items and decisions, e.g. "items 20-29, #64", or "none" -->

## Changes

<!-- Grouped by area (web, engine, docker, docs). One line each; link the main files. -->

-

## Checks

- [ ] Web: `pnpm --filter web lint && pnpm --filter web typecheck && pnpm --filter web test`
- [ ] Engine: `ruff check`, `ruff format --check`, `pytest` (if the engine changed)
- [ ] Tried by hand: <!-- what you ran and saw, or "not needed" -->
- [ ] Security and general review done, findings fixed in this PR

## Rules this PR keeps

- [ ] The engine contract, `openapi.json` and the Orval client change together (or the contract is untouched)
- [ ] No edits to the `apps/web/ee/` stubs
- [ ] Logs only through `lib/log.ts` / `logging.py`; no transcript text, keys or personal data
- [ ] English first; Polish strings added for any new UI text

## Not in this PR

<!-- Known gaps and follow-ups, or "nothing". -->

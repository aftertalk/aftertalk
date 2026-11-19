# Contributing

Issues are welcome: bug reports, questions and feature requests.

Outside pull requests are not accepted yet. They will be once a contributor
licence agreement (CLA) is in place, because a commercial edition is built on
this code.

## Maintainer workflow

1. Branch from `main` (`phase-1`, `engine-contract`, `fix-upload-limit`, ...).
2. Keep a PR to one project where possible: web PRs touch `apps/web/`, engine
   PRs touch `apps/engine/`. A contract change touches both, in one PR.
3. Run the checks listed in `CLAUDE.md` before pushing; CI runs the same ones
   plus a full `docker compose` start.
4. Open a PR that names the spec items it builds ("items 59, 60").
5. CI must be green. Merge only after an explicit yes from a maintainer;
   squash-merge, delete the branch.
6. No AI co-author lines or "Generated with" footers in commits or PRs.

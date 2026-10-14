# 0006. Private vendored code is never published; the rails run from ignored files

**Date:** 2026-10-14
**Status:** accepted

## Context

The backlog-delivery tools and plugin come from a private, unlicensed repository. Adopting the workflow here requires them to be present, and an earlier attempt to publish a personal config repo would have republished them.

## Decision

In this public repo `tools/` and `plugins/backlog-delivery/` are present locally for the rails but are gitignored and never committed. Planning state under docs/backlog is local by default. CI must fail if either path becomes tracked.

## Rationale

The rails need the files on disk, not in history. Keeping them ignored satisfies both without publishing code that is not ours to publish.

## Consequences

A fresh clone has no rails until the vendored copy is added; PBI worktrees will not contain the tools, so PBI work happens on branches in the main checkout. The hook's documented skip-when-absent behaviour must not be mistaken for enforcement.

## Alternatives considered

- **Commit the vendored code** — rejected because publishes private, unlicensed code.
- **Publish a history without it** — rejected because two unrelated histories to maintain; tried and abandoned.
- **Do not adopt the workflow here** — rejected because loses the board that the pane exists to show.

# 0003. The project is the git root, or the repo of the last file touched

**Date:** 2026-10-14
**Status:** accepted

## Context

Sessions are often started from a home directory. A pane that needs a repo then has nothing to read, and the original fix relied on a separate hook writing a state file.

## Decision

Use the git root of the session's directory; if there is none, use the git root of the last file a Read, Edit or Write touched, tracked inside the plugin.

## Rationale

It needs no outside hook, works for every user, and follows the work as it moves between repos.

## Consequences

A session that has touched no file yet shows nothing until it does. Tracking adds one `tool.call` hook that must never block a call.

## Alternatives considered

- **A companion PostToolUse hook** — rejected because a second thing to install, and it was the machine-specific part.
- **A project option** — rejected because wrong the moment you change repos.
- **The process's cwd only** — rejected because fails for sessions launched from home.

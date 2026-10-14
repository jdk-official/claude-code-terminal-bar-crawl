# 0004. Say little: success is silent, failures say what and why

**Date:** 2026-10-14
**Status:** accepted

## Context

The first version confirmed every click ('Opened X in mdt'). It was noise, and the toast the person wanted to see on failure was drowned out.

## Decision

Opening something shows nothing; the new window is the signal. A failure produces one message that names the target and the first line of the error, as a toast and as a line under Docs that clears on the next success. `/dash` always returns a text summary.

## Rationale

A message is worth the attention it costs only when it tells you something you cannot see otherwise.

## Consequences

Silent success means a broken opener looks like a dead click until the failure path fires; the failure path must therefore always run.

## Alternatives considered

- **Always toast** — rejected because noise, and it hides real errors.
- **Never toast** — rejected because a failed launch becomes invisible.
- **Log to the transcript** — rejected because pollutes the conversation the model reads.

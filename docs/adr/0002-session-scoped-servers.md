# 0002. Dev servers are the session's, found by ancestry or working directory

**Date:** 2026-10-14
**Status:** accepted

## Context

A list of every listening socket on the machine is noise. The useful question is which servers belong to what I am doing now.

## Decision

A listener belongs to the session if its process descends from the session's host process, or its working directory is inside the session's repo. Everything else is hidden.

## Rationale

Ancestry catches servers the model started; working directory catches servers the person started in another terminal in the same repo. Together they match what 'mine' means without configuration.

## Consequences

Reads /proc and needs `ss`, so the feature is Linux-only. Containers and proxies that detach from the tree are not shown unless they run from the repo.

## Alternatives considered

- **Port range heuristics** — rejected because other projects use the same ports.
- **Only children of the session** — rejected because misses servers started outside the session in the same repo.
- **Show everything** — rejected because drowns the signal.

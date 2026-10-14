# 0001. Portable by default: options, not constants

**Date:** 2026-10-14
**Status:** accepted

## Context

The mods began as one person's setup: hard-coded project roots, a personal markdown viewer, a window-tracker hook, a theme path. Publishing them as they were would have made them useless to anyone else and leaked a machine layout.

## Decision

Behaviour that differs between machines is a plugin option declared in `userConfig` with a default that works on a plain Linux desktop (`xdg-open`, the git root). Anything that needs a companion hook or a specific compositor is optional and feature-detected.

## Rationale

Options are the engine's own mechanism, shown in `/plugin`, so users configure without editing code. Defaults that work mean first run is useful.

## Consequences

Every new capability must justify an option or a safe default. The README documents each option. Personal setups are expressed as settings, not forks.

## Alternatives considered

- **A fork per machine** — rejected because it is exactly the drift problem this decision exists to avoid.
- **Environment variables only** — rejected because they are invisible in the plugin UI and awkward in desktop sessions.
- **Detect everything automatically** — rejected because guessing a viewer or terminal is wrong often enough to be worse than a default plus an option.

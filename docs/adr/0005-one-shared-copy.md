# 0005. One shared copy of the mods, installed from a marketplace

**Date:** 2026-10-14
**Status:** accepted

## Context

The mods lived twice: a personal copy tuned to one machine and a portable copy for sharing. They drifted within a day.

## Decision

The marketplace plugins are the only copy. A machine's specifics live in plugin options in settings. Personal repos install the plugins rather than vendoring them.

## Rationale

Fixes land once and reach everyone. The personal setup becomes a consumer, which also tests the options.

## Consequences

A change to the plugins is a change to a public package: versioning and release notes now matter. Machine-only behaviour must be expressible as an option or does not ship.

## Alternatives considered

- **Keep a personal fork** — rejected because drift.
- **Vendor the plugins into the personal repo** — rejected because the same drift with extra steps.
- **Symlink the working tree** — rejected because breaks on any machine without that checkout.

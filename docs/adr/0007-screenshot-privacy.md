# 0007. Screenshots are taken from an opaque window with no account data

**Date:** 2026-10-14
**Status:** accepted

## Context

Three captures taken for the README leaked: the tmux status bar showed a hostname, the banner showed the subscription plan, the status line showed usage meters, and a translucent terminal showed other windows' text, including repository names, through the background.

## Decision

Images that go in the repo are captured only from a purpose-built window that is fully opaque, runs in its own tmux socket with a clean environment, uses a generic path, and runs the shipped status line with the usage block removed from its input. A flat-colour check on an empty region must show no variation, and the file must have its metadata stripped. The only permitted edit is covering the plan text.

## Rationale

Each leak was found by looking closely, not by a rule. Writing the checks down makes the next capture repeatable by someone who has not seen the failures.

## Consequences

Taking a screenshot is a small procedure rather than a keystroke, and the demo project is generated so the procedure is cheap to repeat.

## Alternatives considered

- **Crop and hope** — rejected because ghost text and metadata survive cropping.
- **Blur regions after the fact** — rejected because easy to miss one, and it hides the layout.
- **No screenshots** — rejected because the README is much weaker without one.

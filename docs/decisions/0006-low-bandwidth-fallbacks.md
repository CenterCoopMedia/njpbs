# 0006. Low-bandwidth fallbacks

- Status: accepted
- Date: 2026-06-26

## Decision

Use progressive enhancement. Keep primary content usable without optional scripts. Provide static fallbacks, respect reduced data and reduced motion, and defer heavy media.

## Consequences

Implementations must preserve this boundary and verify changes with focused checks.

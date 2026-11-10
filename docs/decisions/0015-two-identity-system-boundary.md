# 0015. Separate identity systems

- Status: accepted
- Date: 2026-07-10

## Decision

Keep public member identity and staff identity in separate systems. Do not copy authentication tokens or private membership records into editorial content. Each integration validates its own audience and authorization boundary.

## Consequences

Implementations must preserve this boundary and verify changes with focused checks.

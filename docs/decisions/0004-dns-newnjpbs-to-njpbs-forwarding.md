# 0004. Domain forwarding

- Status: accepted
- Date: 2026-06-24

## Decision

Keep a single canonical public hostname. Configure redirects at the edge, preserve paths and query strings, and verify HTTPS and loop prevention before changing routing.

## Consequences

Implementations must preserve this boundary and verify changes with focused checks.

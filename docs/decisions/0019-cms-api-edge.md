# 0019. Edge API gateway

- Status: accepted
- Date: 2026-08-13

## Decision

Place the staff API behind a Cloudflare Worker. Validate authentication, origin, and capabilities before forwarding requests. Keep credentials server-side and refuse ambiguous authorization.

## Consequences

Implementations must preserve this boundary and verify changes with focused checks.

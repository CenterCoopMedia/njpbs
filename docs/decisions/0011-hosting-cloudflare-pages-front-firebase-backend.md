# 0011. Website and backend hosting

- Status: accepted
- Date: 2026-07-07

## Decision

Serve the public website through Cloudflare and use Firebase for backend services. Separate the static artifact, backend state, and deployment identity. Configure account identifiers outside source.

## Consequences

Implementations must preserve this boundary and verify changes with focused checks.

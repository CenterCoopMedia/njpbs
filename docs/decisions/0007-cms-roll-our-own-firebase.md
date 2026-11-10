# 0007. Content backend

- Status: accepted
- Date: 2026-06-30

## Decision

Use Firebase authentication and Firestore for the content backend. Keep authorization and content validation on the server. The public website consumes admitted content projections.

## Consequences

Implementations must preserve this boundary and verify changes with focused checks.

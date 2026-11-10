# 0008. Staff authentication

- Status: accepted
- Date: 2026-06-30

## Decision

Keep staff authentication separate from public user identity. Support configured identity providers and approval-gated accounts. Server capabilities govern every protected operation.

## Consequences

Implementations must preserve this boundary and verify changes with focused checks.

# 0014. Media storage

- Status: accepted
- Date: 2026-07-10

## Decision

Keep media binaries in object storage and their metadata in Firestore. Use immutable content-addressed objects, context-specific alternative text, and capability-gated writes. Track working, published, and deployed usage separately. Refuse destructive operations when usage or publication state is uncertain.

## Consequences

Implementations must preserve this boundary and verify changes with focused checks.

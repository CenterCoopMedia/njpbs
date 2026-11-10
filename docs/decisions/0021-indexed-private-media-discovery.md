# 0021. Indexed private media discovery

- Status: accepted for implementation
- Date: 2026-10-03

## Decision

Use bounded server-owned indexes for private media discovery. Search results must obey the same authorization and lifecycle checks as direct reads. Keep binary access capability-gated.

## Consequences

Implementations must preserve this boundary and verify changes with focused checks.

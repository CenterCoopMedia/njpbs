# 0020. Vendor-neutral content integrations

- Status: proposed
- Date: 2026-09-01

## Decision

Use a shared integration contract between content sources, the editor, and public rendering. Keep source credentials and vendor transport details behind server boundaries.

## Consequences

Implementations must preserve this boundary and verify changes with focused checks.

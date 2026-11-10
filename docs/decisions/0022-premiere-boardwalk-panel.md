# 0022. Video editing panel

- Status: accepted
- Date: 2026-10-03

## Decision

Use a dedicated editing panel to access shared video through the content API. Pairing, source access, and upload admission remain server-controlled. Keep local editor paths out of published content.

## Consequences

Implementations must preserve this boundary and verify changes with focused checks.

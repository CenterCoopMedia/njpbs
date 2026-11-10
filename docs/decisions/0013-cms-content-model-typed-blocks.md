# 0013. Typed content blocks

- Status: accepted
- Date: 2026-07-10

## Decision

Store each page or post as a document with ordered typed blocks and immutable identifiers. Share the block catalog across the editor, server validation, and renderer. Store structured rich text and preserve complete revision snapshots.

## Consequences

Implementations must preserve this boundary and verify changes with focused checks.

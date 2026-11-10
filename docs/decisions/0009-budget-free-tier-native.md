# 0009. Resource budgets

- Status: accepted
- Date: 2026-06-30

## Decision

Prefer static output, bounded operations, caching, and services with predictable costs. Track resource use and keep paid integrations behind explicit configuration.

## Consequences

Implementations must preserve this boundary and verify changes with focused checks.

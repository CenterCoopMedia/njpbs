# 0018. Web performance targets

- Status: accepted
- Date: 2026-08-03

## Decision

Target good Core Web Vitals at the 75th percentile. Reserve layout space for media, defer optional work, and measure representative pages with realistic content and devices.

## Consequences

Implementations must preserve this boundary and verify changes with focused checks.

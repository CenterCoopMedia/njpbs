# 0023. Content-only publication

- Status: proposed
- Date: 2026-10-05

## Decision

Publish admitted content without rebuilding unchanged application code. Bind each publication to exact content, code, and renderer identities. Keep immutable artifacts, bounded replay, and explicit recovery state. Refuse promotion when verification is incomplete.

## Consequences

Implementations must preserve this boundary and verify changes with focused checks.

Keep automatic recovery observations in logs and health. Alert only when public output is blocked or automatic recovery is exhausted. Preserve immediate serve-time withdrawal and stale-age refusal, and the first minute check after expiry.

# 0023. Content-only publication

- Status: proposed
- Date: 2026-10-05

## Decision

Publish admitted content without rebuilding unchanged application code. Bind each publication to exact content, code, and renderer identities. Keep immutable artifacts, bounded replay, and explicit recovery state. Refuse promotion when verification is incomplete.

## Consequences

Implementations must preserve this boundary and verify changes with focused checks.

Keep automatic recovery observations in logs and health. Preserve immediate
serve-time withdrawal and stale-age refusal. After expiry, alert when the
replacement fails, exhausts automatic recovery, or reaches the 15-minute rebuild
window without progress. Continue minute checks while replacement work runs;
expiry alone does not send an alert.

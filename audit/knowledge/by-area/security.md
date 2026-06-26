# Security — past findings

## LF-040 · LOW · LiFiTimelockController · fixed

**Recognition signal:** Access-control modifier that interprets a role granted to address(0) as 'permissionless' — a single misconfiguration silently turns privileged functions into open ones.

**Root cause:** The onlyRoleOrOpenRole modifier treats a role as 'open to anyone' when address(0) holds it. Functions like unpauseDiamond() are guarded with this modifier, so an accidental or compromised grant of TIMELOCK_ADMIN_ROLE to address(0) would make sensitive admin actions callable by any address.

**Fix:** Switched to OpenZeppelin's strict onlyRole modifier, removing the 'open role via address(0)' bypass. Fixed in b26f9526c408fb0e2731e095b1188677706e97cb.

**Source:** `2025.01.10_Timelock(v1.0.0).pdf` p.5-5 · `audit20250110_2::6.1.1`

---

## LF-041 · INFO · LiFiTimelockController · acknowledged

**Recognition signal:** Timelock controller exposing a 'fast path' admin action (emergency unpause, emergency cancel) that skips the configured delay — even if scoped, it weakens the protocol's guaranteed observation window.

**Root cause:** unpauseDiamond() is callable without enforcing the timelock's delay, so the multi-sig holding TIMELOCK_ADMIN_ROLE can immediately re-activate the Diamond. While the action is constrained (it can only remove facets while unpausing), it still bypasses the timelock's transparency window.

**Fix:** Acknowledged; the multi-sig is trusted to use this safely. No code change.

**Source:** `2025.01.10_Timelock(v1.0.0).pdf` p.5-5 · `audit20250110_2::6.2.1`

# [Contract Name] — Smart Contract Design

> **Status:** `READY` | `BLOCKED — security review` | `BLOCKED — product clarification`
> **Version:** v_N
> **Date:** YYYY-MM-DD

## 0. Source PRD

- **Link:** <full URL or path to the PRD>
- **Title:** <PRD title>
- **Ingested:** YYYY-MM-DD
- **Notes:** <e.g. depth-2 child pages also ingested; specific sections used>

## 1. Purpose & product context

One paragraph, in plain language, of *what this contract is for in the product*. Lifted from the PRD, attributed.

## 2. Scope: what this contract DOES

Bullet list of the contract's responsibilities. Each item should map to a PRD requirement.

## 3. Scope: what this contract does NOT do

Explicit non-goals. This section exists because in smart contracts, what is *out* of scope matters as much as what is in. Examples: "does not custody user funds", "does not implement governance", "does not interact with non-EVM chains".

## 4. Architecture & components

Diagram-as-text (ASCII or mermaid). Module breakdown: which Solidity contracts, libraries, interfaces. Inheritance tree if non-trivial.

## 5. External interactions

Table of every other contract this design depends on:

| Counterparty | Chain(s) | Interaction | Trust assumption |
|---|---|---|---|

## 6. State model & storage layout

Storage variables, packing strategy, upgrade-safety considerations. Include a slot table for upgradeable contracts.

## 7. Access control & roles

Every privileged role: who holds it, what it can do, how it is granted/revoked, timelock requirements, multisig requirements.

## 8. Upgrade & operational model

- Upgradeable? (UUPS / Transparent / Beacon / Immutable)
- Initializer pattern.
- Pause mechanism.
- Key custody (multisig threshold, signers, geography).
- Emergency procedures.

## 9. Invariants

Numbered list of properties that must always hold. Each one must be expressible as a fuzz/symbolic check. Example:
1. `totalSupply() == sum(balances)`
2. `sharePrice` is monotonically non-decreasing except on documented loss events
3. Only `ADMIN_ROLE` can call `setFeeRate`

## 10. Threat model & mitigations

Adversaries enumerated, attack paths considered, mitigations in place. Reference invariants from §9 where applicable.

## 11. Gas / optimization notes

Where gas-vs-clarity tradeoffs were made. Where they were *refused* on security grounds. Approximate gas costs for the main user-facing functions if estimable.

## 12. Open questions / deferred decisions

Numbered list. Each one labelled `(minor)` or `(deferred)`. Material gaps should not appear here — they triggered a HALT in Phase 1.

## 13. Custody of funds

**This section is mandatory and must take an explicit position.**

State whether the contract holds user/protocol funds at any point.

### If the contract does NOT custody funds

> "This contract does not hold user or protocol funds at any point. <one-line justification, e.g. 'all transfers are pass-through; tokens are pulled from the user and forwarded to the destination protocol within the same call'>."

When this branch applies, the sub-sections below (13.1 / 13.2 / 13.3) MUST still appear with their headers — write `N/A — non-custodial (see above)` under each. Headers are never deleted; the template's structural shape is preserved across all designs.

### If the contract DOES custody funds

This is the default-disfavoured path. The PRD requirement that drives custodianship must be cited here. The following sub-sections are mandatory.

#### 13.1 Why funds must be held

What product requirement requires custody. What alternatives (pass-through, approval-based, just-in-time) were considered and rejected, and why.

#### 13.2 Risk assessment

- **Loss scenarios:** enumerated. Examples: admin key compromise; signer compromise; oracle manipulation; logic bug; donation attack; flash-loan amplification; dependency compromise.
- **Blast radius per scenario:** what is the maximum value at risk; can the loss be bounded.
- **Max value at risk:** expected and worst-case TVL the contract is designed to hold.

#### 13.3 Security strategy

For each loss scenario in 13.2, the mitigation:
- Timelocks on privileged actions.
- Withdrawal limits / rate limits / per-address caps.
- Circuit breakers and pause authority.
- Monitoring (which on-chain events are watched, by whom, with what response time).
- Incident response runbook reference.
- Insurance or coverage arrangement, if any.

If a loss scenario cannot be mitigated below acceptable threshold, this is a finding for the security auditor in round 1.

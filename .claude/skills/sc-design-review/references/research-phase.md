# Phase 1.5 — Comparable-product research

Load before dispatching research subagents. Carries the subagent prompt template, the synthesis output template, a worked example, and anti-patterns. The Phase 1.5 body in `SKILL.md` is the abstract recipe; this file is the operational detail.

## Why this phase is worth the cost

A hardened SC design routinely depends on findings that are public knowledge in comparable-product source / governance archives / post-mortems, but absent from the PRD. Examples seen in past designs:

- First-depositor inflation attack on ERC-4626 — mitigation comes from reading OpenZeppelin / Yearn / Morpho source.
- Beacon-key landmines — one global upgrade key compromises every clone (Kiln's pattern; documented anti-pattern).
- JIT-deposit reward gaming — invisible until you read Synthetix `MultiRewards` and the streaming-vs-lump-sum literature.
- Withdraw-pause anti-pattern — Kiln explicitly does NOT pause withdrawals; pattern requires reading their access-control config.

These are not exotic. They are dominant-failure-mode patterns in the comparable systems. Skip the research phase and the security auditor in Phase 3 will surface them — at maximum cost, with the design already drafted around assumptions that now have to be unwound.

Run the research in parallel with the ambiguity gate. Cost: ~5–10 minutes of wall-clock, 3–5 subagent dispatches. Value: 20–30% of the load-bearing findings in v1, surfaced before drafting starts.

## The comparable set — pick by role, not name

| Role | What it gives you |
|---|---|
| **Explicit blueprint** | The system the PRD itself references ("we want one of these"). Highest signal-to-noise; this is where COPY/IMPROVE come from. |
| **Marquee-customer reality** | What a named target customer actually uses on-chain today. Often diverges from what the PRD assumes about them. Surfaces "the PRD designs for X, but the customer's existing stack does Y" tensions. |
| **Dominant competitor / win-back** | The system being displaced. Tells you what the catalogue must beat, not just match. |
| **Field-wide comparison** | Table across 5–10 adjacent systems, shallow per cell. Surfaces convergent architecture patterns — when 6 of 8 comparables do the same thing, that's a high-confidence default. |
| **Adjacent-but-distinct** | A different problem with related architecture. Clarifies what your scope is *not* (e.g. "Aave is a pool, not a wrapper — we're not designing a pool"). |

Below 3 comparables: no triangulation; convergent findings could be coincidence. Above 5: the operator can't hold the synthesis in head. The sweet spot is 3–4 with the field-wide as a wide-shallow companion.

## Subagent prompt template

Each comparable gets one subagent dispatched in parallel. Standard brief:

```
You are researching <COMPARABLE_NAME> as a comparable for the
<PROJECT_NAME> smart contract design. Your role in the comparable
set is <ROLE: blueprint | marquee-customer-reality | competitor
| field-wide | adjacent-but-distinct>.

CONTEXT (1–2 paragraphs):
- What we're designing (1 sentence).
- Why this specific comparable is in the set (1 sentence).
- Downstream consumer: the Tech Lead drafting v1 of an SC design doc;
  hardening rounds by a 6-persona panel follow.

REQUIRED READING (primary sources only):
- Project docs URL
- Verified contract source on Etherscan / Basescan / etc.
- Public GitHub repo if open
- Governance archives (Snapshot / on-chain governor / forum threads)
- Public incident post-mortems / bug-bounty disclosures
- Dashboard data (Dune, DefiLlama) where TVL / usage is relevant
Do NOT cite secondary sources (Medium posts, listicles). If a primary
source isn't available, mark the claim "unverified."

SCOPE — answer 4–7 of these, picking the load-bearing ones:
- Architecture & topology (factory? proxy pattern? upgrade model?)
- Fee / monetization mechanism (rates, caps, accrual model, sweep authority)
- Permissioning / access control (whitelist / blacklist / KYB / sanctions)
- Failure-mode handling (pause topology, recovery, key-loss, migration)
- Public incident history
- Governance / change-control / timelock model
- Reward injection / external-incentive surface
- Observability / event schema
- Known weaknesses / community-flagged anti-patterns
- Composition story (who builds on top; integration interfaces)

OUTPUT:
- Structured markdown, ~300–500 lines, primary-source citations inline.
- Final section: "Unverified items" — list every claim you couldn't
  verify against a primary source. Don't fabricate.
- Closing frame (MANDATORY, exactly 3 lines):
    COPY: <what to mirror in our design>
    IMPROVE: <what to do a stronger version of>
    AVOID: <what to invert / not repeat>

CONSTRAINTS:
- You are one of N parallel subagents. You can't see other agents'
  outputs. Don't speculate about what they found.
- Cap output at <WORD_BUDGET> words. Be dense.
- Don't propose design choices for <PROJECT_NAME>. Your job is the
  comparable. The Tech Lead synthesises.
```

Tune `<WORD_BUDGET>`: 800 for blueprint, 500 for competitor/field-wide, 300 for adjacent-but-distinct.

## Synthesis output template — `research/research-analysis.md`

```markdown
# Research Analysis — Comparable Products

Background for the <PROJECT_NAME> SC design. Compiled <DATE> from
primary sources. Raw per-comparable research in [`raw/`](raw/).

## A. <Comparable 1 name> — the explicit blueprint
[~300–400 words: architecture, primary mechanism we care about, fee /
auth / pricing, governance, known weaknesses. Lift from raw/01.]

**COPY**: <what to mirror>
**IMPROVE**: <what to ship a stronger version of>
**AVOID**: <what to invert>

## B. <Comparable 2 name> — marquee-customer reality
[Same shape.]

...

## Cross-cutting findings

1. [Convergent pattern across ≥2 comparables: e.g. "all converged on
   factory + immutable-per-instance + timelocked-mutable-params."]
2. [Repeated anti-pattern: e.g. "every product with a single global
   upgrade key has had at least one near-miss / incident."]
3. [Convergent constraint: e.g. "every product in this space ships
   without an X capability — confirms X is V2/V3 territory."]
```

The cross-cutting section is where the value compounds. Convergence across independently-dispatched subagents is a high-confidence signal. Flag every cross-cutting finding inline.

## Worked example — Programmable Vault Wrapper

**Project**: LI.FI Programmable Vault Wrapper (ERC-4626 wrapper factory + clone topology, per-integrator instances around well-behaved underlying vaults).

**Comparable set picked**:

| Role | Comparable | Why |
|---|---|---|
| Explicit blueprint | Kiln Omnivault | PRD names it: "clone of the Kiln pattern" |
| Marquee-customer reality | Coinbase USDC Earn (Morpho/Steakhouse + Merkl stack) | Coinbase is a named target integrator; their actual on-chain stack matters more than what the PRD assumes about them |
| Field-wide | Morpho MetaMorpho / Yearn V3 / Veda / Lagoon / Mellow / Superform / Sommelier / Idle | 8-row table across the EVM 4626/7540 wrapper landscape |

Three subagents, dispatched in parallel. Output landed in `raw/01-kiln-omnivault.md`, `raw/02-coinbase-reward-injection.md`, `raw/03-similar-products.md`. Synthesised into `research-analysis.md`.

**COPY/IMPROVE/AVOID excerpts that drove the design**:

- *Kiln COPY*: beacon-proxy factory, OZ-`ERC4626Upgradeable` base, `AccessControlDefaultAdminRules` 2-step admin, `FeeRecipient[]` split with permissionless dispatch, `pendingFee` two-phase update, `minTotalSupply` + `offset_` (inflation-attack mitigations), OFAC `SanctionsList` + `BlockList`.
- *Kiln IMPROVE*: first-class streamed reward primitive (Synthetix `MultiRewards.notifyRewardAmount`) — fixes JIT-attackability of Kiln's "Reinvest" mode; permissionless harvest with keeper-bond — inverts Kiln's `CLAIM_MANAGER_ROLE` operational dependency.
- *Kiln AVOID*: global beacon controlling all integrators (the single biggest landmine — one key compromises everyone); Kiln-operated weekly keeper (single point of liveness failure); strategy hardcoded at init (no migration without redeploy).
- *Coinbase COPY*: nothing on-chain (Coinbase ships no reward contract; the 10.8% APY is ~6% organic + ~5% Morpho-funded marketing boost via Merkl).
- *Coinbase IMPROVE*: ship an on-chain `notifyRewardAmount` primitive — gives integrators a more direct primitive than Coinbase has today via the Morpho stack.
- *Coinbase AVOID*: don't make Merkl the default — it's off-chain-trust-anchored.

**Cross-cutting findings**:

1. Converged architecture skeleton across MetaMorpho, Yearn V3, Lagoon: factory + immutable-per-vault + timelocked-mutable-params + guardian-veto. Adopt the same.
2. Perf-fee cap encoded in implementation is the integrator-trust primitive — Morpho caps at 50%, Kiln has no cap. Without an immutable cap the wrapper is socially indistinguishable from "trust the deployer."
3. Two viable reward-injection shapes: (a) harvest-and-reinvest into NAV (Idle, Yearn, Sommelier); (b) external distributor decoupled from share accounting (Morpho URD/Merkl, Mellow `RewardsDistributor`). Support (b) as primary so the wrapper stays 4626-clean; (a) optional for compound mode.

The full realised output of this exact recipe is committed in `earn-monetization-v2-vault-wrapper/raw/` + `research-analysis.md` in the LiFi business-projects folder — load that if you need a reference shape.

## Anti-patterns

- **One subagent doing all comparables.** Loses parallel-independence value; introduces correlated bias. Output reads as a wiki, not as triangulated findings.
- **Reading other agents' outputs mid-flight.** Convergent answers look like consensus but are correlation. Read after all return.
- **Citing secondary sources.** A Medium post about Morpho isn't a source — Morpho's docs, contract source, governance forum, or audit reports are.
- **Skipping COPY / IMPROVE / AVOID.** Research becomes reference material; the Tech Lead can't trace design choices back to it.
- **Research after the draft is locked.** Re-opens v1 and erodes the audit trail. Run in parallel with the ambiguity gate.
- **Padding the comparable set.** Below 3 = no triangulation; above 5 = unmanageable synthesis. Resist "and we should also look at …" past 5.
- **Letting the blueprint dominate.** Every other comparable should pull weight. If the blueprint accounts for >60% of the research-derived design content, the comparable set was mis-picked.
- **Spending the research budget on what the PRD already cites.** If the PRD already says "we copy Kiln's fee model," the research subagent on Kiln should focus on what's NOT in the PRD (Kiln's failure modes, governance landmines, weaknesses) — not re-derive what's already settled.

## When to skip Phase 1.5 entirely

- The PRD describes a feature for which the existing LiFi codebase already contains a near-canonical pattern (e.g. another facet with the same shape). The pattern *is* the research.
- The ambiguity gate HALTed in Phase 1 with material gaps. Save the dispatched research for the next run after the executor returns answers.
- The design is a minor extension to an already-audited contract. Run targeted research scoped to the extension surface only, not the full system.

In all other cases, run Phase 1.5. Cost is low; the cost of skipping is high and back-loaded.

---
name: review-bounty-report
description: Reviews a Cantina bug bounty submission against the codebase, docs, audit log, program scope and severity matrix, challenging every claim. Use when the user pastes a bounty report (optionally with the platform's AI analysis) for triage.
usage: /review-bounty-report
---

# Bug Bounty Report Review

> **Usage**: `/review-bounty-report` (then paste the report and any platform AI analysis)

Skeptical review: challenge every claim (vulnerability, impact, scope, severity, fix); don't
accept the report or the platform AI at face value. Output goes in chat only — write no files.

**Inputs:** the report text (required); optionally the platform AI analysis (any format), the
program URL, cited commits/paths, pasted audit report text.

**Audit PDFs:** the agent cannot read PDFs from the repo — don't claim to have read
`audit/reports/*.pdf`. Use `audit/auditLog.json` to find relevant audits and add a **Manual**
task to open them. If the user pastes audit text, compare against it.

## Program scope (LI.FI Cantina bounty)

Program: <https://cantina.xyz/code/260585d8-a3e8-4d70-8077-b6f3f5f0391b/overview>

**In scope:** repo `github.com/lifinance/contracts`, latest commit, `src/**/*.sol`; scan.li.fi,
li.fi, portal.li.fi, li.quest/*; case-by-case: unlisted components that risk user funds, user
data, or system integrity.

**Out of scope** (abbreviated; the program page is exhaustive):

- **Bridge/DEX**: relayer latency; bridge fee fluctuations; cross-chain reorg theories; bridge
  liquidity limits; oracle price delays; slippage within tolerance; MEV/front-running; route
  optimization; gas-only; DEX availability.
- **Contracts**: centralization by design; non-exploitable reentrancy; flash loan without proof
  under realistic conditions; upgradeability-by-design; governance requiring >10% supply;
  known/acknowledged in audits; **self-crafted calldata** (our contracts expect
  backend-generated calldata); **idle/dust in LiFiDiamond** (not a vulnerability); cross-EVM
  address mismatch (non-prod); deprecated `/archive`; Lightchaser automated list; duplicates;
  atomic tx reverts; precision/dust reverts in integrations; third-party protocol bugs; known
  doc'd issues; test code; user error; theoretical without PoC; under remediation.
- **Web**: per the program page.
- **Doc/minor**: doc discrepancies; missing events; missing zero-address checks; missing input
  validation — unless they lead to permanent fund loss or clear security impact.

## Severity (smart contracts)

**Impact** (% of daily total user transfers across all EVM chains): Critical 50–100% or
governance; High 20–50%; Medium 0.5–20%, or serious reputational/legal/financial harm to many
users; Low/Info minimal direct risk.

**Likelihood:** High = very easy / highly incentivized; Medium = possible under conditions;
Low = difficult or very specific conditions.

| Likelihood \ Impact | Critical | High | Medium | Low |
|---|---|---|---|---|
| High | Critical | High | Medium | Low |
| Medium | High | High | Medium | Low |
| Low | Medium | Medium | Low | Informational |

Policies for applying it:

- **Volume:** never hardcode it. When impact depends on % of daily volume, web-search recent
  figures (e.g. "li.fi monthly volume"), reason in orders of magnitude (daily ≈ monthly/30), and
  print the assumed volume and source in the output.
- **Subset at risk:** when only part of the value is at risk (e.g. positive slippage, not
  principal — typically 0.1–2% of notional per tx), the at-risk share of daily volume is small.
  Prefer **Low** or flag **borderline Low/Medium** and challenge the rating so the user decides.
- **Conjunctive conditions:** likelihood is the conjunction of every precondition; list them
  all. Malicious/compromised intermediary (frontend, relayer, integrator) **and** a specific
  path (e.g. swap+bridge only) **and** a particular outcome (e.g. positive slippage) → **Low**,
  not Medium. "Malicious frontend is a real threat" alone never justifies Medium.
- **High/Critical bar:** requires harm across many flows/tools/chains or protocol insolvency;
  default to questioning these and flag **Overrated** when the reporter's rating exceeds yours.
- **Uncertainty:** if impact or likelihood can't be validated with available data, output
  "Severity: Unclear — <what is missing>" and ask the user, rather than guessing.

## Workflow

1. **List claims** — root cause, attack steps/preconditions, claimed impact and components,
   claimed scope, reporter's severity and fix.
2. **Code and docs** — map each claim to `src/`, the contract's doc under `docs/` when it exists
   (e.g. `EcoFacet.sol` → `docs/EcoFacet.md`), and all NatSpec and inline comments (they often
   document deliberate design choices). Code and storage layout are truth; comments give intent.
   Record supporting, contradicting, and missing evidence (file:line) per claim.
3. **External systems** — if bridges/DEXs/oracles are involved, fetch their official docs and
   decide whether the attack relies on our integration (in scope) or a third-party bug or
   assumption (likely out of scope).
4. **Scope** — In scope? Yes / No / Unclear, with the reason (e.g. "Self-crafted calldata",
   "Third-party bridge bug", "Known in audit X").
5. **Severity** — apply the section above.
6. **Duplicate/known** — list relevant audits (IDs and `auditReportPath`) from
   `audit/auditLog.json`; compare against pasted audit text; add a **Manual** task to check the
   PDFs and prior bounty submissions.
7. **Fix** — does the reporter's fix fully remove the issue, could it break invariants, and is
   there a simpler mitigation (validation vs refactor)?

## Output (chat only)

Use bold headings followed by text — no markdown tables, so nothing truncates.

1. **Summary** — Claim (one sentence); In scope? (Y/N/Unclear + why); Valid? (Y/N/Unclear +
   why); Severity (plus "Overrated" if applicable, or "Unclear" + what you need); Required
   conditions; Main gap/risk; Top 3 manual follow-ups.
2. **Severity reasoning** — Impact + why (program definitions, what is actually at risk);
   Likelihood + why (preconditions and their conjunction); Required conditions (bullets);
   Volume assumption (assumed monthly/daily figure and source, or "Not used"); Resulting
   severity from the matrix; Reporter's severity vs this assessment (Overrated / Unclear + why).
3. **Verdict** — In scope? · Valid? · Severity · Overrated? · Duplicate/Known?
4. **Evidence map** — per major claim: Supporting · Contradicting · Missing.
5. **Assumptions** — each marked stated-in-report or inferred.
6. **Manual tasks** (checklist):
   - [ ] Reproduce on a fork (if applicable).
   - [ ] Confirm scope against the full program page.
   - [ ] Open relevant audit PDF(s) from `audit/reports/` and check for the same finding.
   - [ ] Check for duplicates in past bounty reports (Cantina dashboard / internal list).
   - [ ] Validate severity via Impact × Likelihood and the % daily volume bar.
   - [ ] Review the fix (and alternatives) with devs before accepting or rejecting.
7. **Relevant audits** — audit IDs and `auditReportPath` from `audit/auditLog.json`.

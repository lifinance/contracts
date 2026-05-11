---
name: review-bounty-report
description: Review and analyze a Cantina bug bounty report against codebase, docs, audits, scope, and severity
usage: /review-bounty-report
---

# Bug Bounty Report Review Command

> **Usage**: `/review-bounty-report` (then paste the bug bounty report and any platform AI analysis into the chat)

## Purpose

Perform a structured, skeptical review of a Cantina bug bounty submission. Challenge every claim (vulnerability, impact, scope, severity, fix). Use the codebase, docs, audit metadata, and external protocol docs as sources of truth. Output is **log only** (no file written).

## Inputs

- **Required**: Full text of the bug bounty report (and, if present, the platform's AI analysis in any format—interpret freely, no fixed structure assumed).
- **Optional**: Program URL for reference; specific commit or file paths the reporter cited; pasted or attached audit report text when comparing to a prior audit.

**Audit PDFs**: The agent cannot read PDFs from the repo. Use `audit/auditLog.json` to identify relevant audits. If the report concerns an audited contract, list those audit report paths and add a **Manual** task to open the PDF(s) and check for the same/similar findings. If the user attaches or pastes audit report text, use it in the comparison.

---

## Program Scope (LI.FI Cantina Bounty)

**Program reference**: https://cantina.xyz/code/260585d8-a3e8-4d70-8077-b6f3f5f0391b/overview

### In-Scope

- **Smart contracts**: Repo `github.com/lifinance/contracts`, latest commit, files `src/**/*.sol`.
- **Case-by-case**: Vulnerabilities in components not explicitly listed but that pose risk to user funds, user data, or system integrity.

### Out-of-Scope (abbreviated; check full program for exhaustive list)

- **Bridge/DEX**: Relayer latency; bridge fee fluctuations; cross-chain reorg theories; bridge liquidity limits; oracle price delays; slippage within tolerance; MEV/front-running; route optimization; gas-only; DEX availability.
- **Contracts**: Centralization by design; non-exploitable reentrancy; flash loan without proof under realistic conditions; upgradeability-by-design; governance requiring >10% supply; known/acknowledged in audits; **self-crafted calldata** (our contracts expect backend-generated calldata); **idle/dust in LiFiDiamond** (not a vulnerability); cross-EVM address mismatch (non-prod); deprecated `/archive`; Lightchaser automated list; duplicates; atomic tx reverts; precision/dust reverts in integrations; third-party protocol bugs; known doc'd issues; test code; user error; theoretical no PoC; under remediation.
- **Doc/minor**: Doc discrepancies; missing events; missing zero-address checks; missing input validation—unless they lead to permanent fund loss or clear security impact.

### Severity (Smart Contracts)

**Impact** (by % of daily total user transfers across all EVM chains):

- **Critical**: 50%–100% of daily total user transfers; governance.
- **High**: 20%–50%.
- **Medium**: 0.5%–20%; or serious reputational/legal/financial for many users.
- **Low/Info**: Minimal direct risk.

**Impact when only a subset is at risk**: When only a fraction of the transfer value is at risk (e.g. positive slippage, not principal), the *at-risk* amount as % of daily total user transfers is much smaller than the volume through the affected path. The program's Medium band (0.5%–20%) can correspond to large absolute sums. **Do not hardcode volume.** When impact depends on % of daily volume, run a **quick web search** (e.g. "li.fi monthly volume" or "LI.FI transaction volume") to get recent figures; use them to reason about order of magnitude (e.g. daily ≈ monthly/30) and cite briefly in the severity reasoning. Positive slippage is typically a small fraction of notional per tx (e.g. 0.1%–2%), so the effective share of daily volume actually at risk is often **Low** or **borderline Low/Medium**. In such cases, prefer **Low** or explicitly flag **"borderline Low/Medium"** and **challenge the rating** in the output so the user can make an informed decision.

**Likelihood**: High = very easy / highly incentivized; Medium = possible under conditions; Low = difficult or very specific conditions.

**Conjunctive conditions**: When the attack requires several conditions to *all* be true (e.g. specific component, valid credential, malicious intermediary, and a particular market outcome), treat likelihood as the **conjunction** of those conditions. List every required condition explicitly; the overall likelihood is low unless each condition is independently likely. Do not rate likelihood based on only one condition (e.g. "frontend can be malicious") while ignoring that others (narrow scope, valid signature, specific execution path) must also hold.

**Likelihood = Low when**: The attack requires (1) a malicious or compromised intermediary (frontend, relayer, or integrator that builds/submits the tx) **and** (2) a specific execution path (e.g. only swap+bridge, not plain bridge) **and** (3) a particular outcome (e.g. positive slippage, favourable market). That conjunction is **Low** likelihood—not Medium. Reserve **Medium** for scenarios with fewer or less stringent conditions (e.g. no malicious intermediary, or only one extra condition).

**Uncertainty**: If impact magnitude (e.g. % of daily volume at risk) or likelihood (e.g. how often required conditions align) is unclear or depends on data you do not have, **ask the user** for clarification or relevant metrics rather than stating a vague or unvalidated severity. Prefer "Severity: Unclear—[what is missing]" plus a short question than a guess.

**Risk matrix** (Impact × Likelihood → Severity):

- **Likelihood High** × Critical → Critical; × High → High; × Medium → Medium; × Low → Low.
- **Likelihood Medium** × Critical → High; × High → High; × Medium → Medium; × Low → Low.
- **Likelihood Low** × Critical → Medium; × High → Medium; × Medium → Low; × Low → Informational.

**Bar for High/Critical**: With impact defined as % of daily tx volume, High/Critical are unlikely unless the attacker can redirect or harm funds across many flows/tools/chains—explicitly check for overrating.

---

## Workflow

Follow these **7 steps** in order.

### 1. Parse and list claims

From the report (and any platform AI analysis), extract without assuming a fixed structure:

- Vulnerability description and root cause
- Attack steps / preconditions
- Claimed impact and affected components
- Claimed scope (contracts/sites)
- Reporter's suggested severity and fix

List each claim clearly so every one can be checked.

### 2. Code and docs (codebase)

- Map each claim to `src/`, **contract-specific** documentation under `docs/` when it exists (e.g. `EcoFacet.sol` → `docs/EcoFacet.md`), and **all** inline commentary: NatSpec (`@notice`, `@dev`, `@param`, `@return`, etc.) and non-NatSpec block or line comments. Do not skip or skim comments—they often document behavior, invariants, and deliberate design choices.
- Use **code and storage layout as source of truth**; use comments for intent, rationale, and known limitations.
- For every claim, note: **supporting** evidence (file:line or doc section), **contradicting** evidence, **missing** evidence (e.g. "reporter says X but no code path shown").
- If the report references specific files or functions, open them and verify.

### 3. External systems (bridges, DEXs, oracles)

- If the report involves external protocols (bridges, DEXs, oracles, etc.): **always** fetch and use their official docs (integration guides, flows, security assumptions).
- Understand how the integration is supposed to work and what the external system guarantees.
- Decide whether the attack relies on:
  - **Our integration** (in scope), or
  - **A bug or assumption in the third-party protocol** (likely out of scope: "Third-Party Protocol Issues").
- State which components are in-scope vs third-party and why.

### 4. Scope check

- For each claim, check against:
  - In-scope targets (repo `src/**/*.sol`, scan.li.fi, li.fi, portal.li.fi, li.quest/*, and case-by-case clause).
  - The full out-of-scope list (bridge/DEX exclusions, contract exclusions, web exclusions, doc/minor).
- Output: **In scope?** Yes / No / Unclear, with a short reason (e.g. "Self-crafted calldata", "Third-party bridge bug", "Known in audit X").

### 5. Severity assessment

- **Impact**: Apply the program's definitions (Critical/High/Medium/Low by % of daily transfers). Consider scope (which flows, chains, components) and what is actually at risk (e.g. only a subset of funds or a narrow path). When impact depends on % of daily volume, run a **quick web search** (e.g. "li.fi monthly volume") to get recent figures and use them to reason about order of magnitude; do not hardcode volume. When only a subset is at risk (e.g. positive slippage, not principal), the at-risk share of daily volume is often small—prefer **Low** or flag **borderline Low/Medium** and highlight for the user to decide.
- **Conditions**: Enumerate every precondition the attack depends on (e.g. specific contract/facet, valid backend output, role of a third party, market or timing condition). Treat likelihood as the **conjunction** of all of these: the scenario is only as likely as the combined probability that every condition holds.
- **Likelihood**: Assess High/Medium/Low for the *full* attack path, not for a single condition in isolation. If the scenario requires **malicious/compromised submitter + specific path + particular outcome** (e.g. positive slippage), assign **Low** likelihood. Do not assign Medium solely because "malicious frontend is a real threat"—the conjunction of all conditions is what matters.
- **Severity**: Apply the risk matrix to Impact × Likelihood. If impact or likelihood is uncertain (e.g. missing volume/usage data or unclear likelihood of a condition), state "Unclear" and ask the user instead of guessing.
- If the reporter's severity is higher than this, flag **Overrated** and explain with reference to impact scope and conjunctive conditions.
- High/Critical require strong justification (e.g. broad redirect across many flows/chains or protocol insolvency).

### 6. Duplicate / known

- Use `audit/auditLog.json`: which contracts/versions were audited and report paths.
- If the finding touches an audited contract, list **Relevant audits** (report paths from auditLog).
- State: **Manual:** Compare to the actual audit PDF(s) and to prior bounty submissions for duplicate or acknowledged issues.
- If the user pasted or attached audit text, compare the finding to it and note overlap or resolution.

### 7. Fix assessment

- Evaluate the reporter's suggested fix:
  - Does it fully remove the vulnerability?
  - Could it introduce new risks or break invariants?
- Consider **alternative or simpler** mitigations (e.g. validation vs refactor) and note if a better fix exists.

---

## Output Format (log only, structured)

Produce the following in the chat only. Be concise; focus on what matters for accept/reject and next steps.

### 1. One-page summary

Use **heading + text** format (no markdown tables) so the summary does not get truncated. For each item below, output a bold heading followed by one or more lines of plain text.

**Claim**  
One-sentence description of the reported issue.

**In scope?**  
Yes / No / Unclear. One line why.

**Valid?**  
Yes / No / Unclear. One line (e.g. code path exists, third-party only, or not reproducible).

**Severity**  
Your assessment (and "Overrated" if reporter's is higher). If uncertain, say "Unclear" and what you need from the user.

**Required conditions**  
If the attack depends on multiple conditions that must all hold, list them briefly so the reader can judge conjunctive likelihood.

**Main gap/risk**  
Biggest open question or residual risk.

**Top 3 manual follow-ups**  
Numbered list (1. … 2. … 3. …).

### 2. Severity reasoning (dedicated section)

Present the reasoning for Impact and Likelihood so the reviewer can follow the agent’s thought process. Do not only state the final severity; justify each step.

- **Impact**: [Critical / High / Medium / Low]
  - **Why**: 1–3 sentences referring to program definitions (e.g. % of daily volume at risk, which flows/chains/components, what is actually at risk—principal vs slippage vs narrow path). If only a subset of funds is at risk (e.g. positive slippage, not principal), the at-risk share of daily volume is typically small—state **Low** or **borderline Low/Medium** and **challenge the rating** so the user can decide. When relevant, run a quick web search for current LI.FI/volume figures and cite the order of magnitude (e.g. "Only slippage at risk; [cite approximate daily volume from search]; 0.5% of that is $X—consider Low or borderline—user to confirm.").
- **Likelihood**: [High / Medium / Low]
  - **Why**: 1–3 sentences: list the preconditions the attack depends on; state that likelihood is the **conjunction** of these; explain why the combined scenario is High/Medium/Low. If the attack requires malicious/compromised submitter and specific path and particular outcome (e.g. positive slippage), the conjunction is **Low**—say so explicitly (e.g. "requires compromised frontend and swap path and positive slippage → all must hold → **Low**").
- **Required conditions** (bullets): Every precondition that must hold for the attack to succeed.
- **Volume assumption (if used)**: If a web search or other source was used to obtain volume figures for impact reasoning, **print the assumed monthly volume** (and derived daily if relevant) and a brief source note (e.g. "Assumed monthly volume: ~$X B from [search/source]; daily ≈ $Y."). If no volume figure was used, state "Not used" or omit.
- **Resulting severity** (from risk matrix): [Critical / High / Medium / Low / Informational]
- **Reporter’s severity vs this assessment**: If the reporter claimed a higher severity, state **Overrated** and one line why (e.g. impact scope, conjunctive conditions). If uncertain (e.g. missing volume data), state **Unclear** and what is needed from the user.

### 3. Verdict (heading + text, no table)

Use **heading + text** format so the verdict does not get truncated. For each criterion below, output a bold heading followed by the result on the next line.

**In scope?**  
Yes / No / Unclear.

**Valid?**  
Yes / No / Unclear.

**Severity**  
Critical / High / Medium / Low / Informational.

**Overrated?**  
Yes / No.

**Duplicate/Known?**  
Yes / No / Unclear.

### 4. Evidence map

For each major claim (e.g. "attacker can drain X", "missing check in Y"):

- **Supporting**: Code/docs references that support the claim.
- **Contradicting**: Code/docs that contradict or limit the claim.
- **Missing**: What evidence would be needed to confirm (e.g. PoC, specific flow).

### 5. Assumptions

- List assumptions the analysis relies on (e.g. "attacker controls X", "chain Y is live", "calldata from backend").
- Mark which are stated in the report vs inferred.

### 6. Manual tasks

Checklist for the human reviewer:

- [ ] Reproduce on a fork (if applicable) with the described steps.
- [ ] Confirm scope against the full program page (in-scope / out-of-scope).
- [ ] Open relevant audit PDF(s) from `audit/reports/` (see auditLog) and check for same/similar finding.
- [ ] Check for duplicate with past bounty reports (Cantina dashboard / internal list).
- [ ] Validate severity using Impact × Likelihood and % daily volume bar.
- [ ] Review fix (and alternatives) with devs before accepting or rejecting.

### 7. Relevant audits (if applicable)

- From `audit/auditLog.json`, list audit IDs and `auditReportPath` for contracts involved so the reviewer knows which PDFs to open.

---

## Rules

- **Challenge everything**: Do not accept the report or platform AI at face value. For each claim, ask: Is this in our code? In scope? Proven? Severity justified?
- **Code is truth**: Prefer evidence from `src/` and `docs/` over unsupported assertions.
- **External docs**: When bridges/DEXs are involved, fetch and use official docs; separate "our integration" from "their protocol."
- **No PDF reads from repo**: Do not claim to read `audit/reports/*.pdf`; use auditLog and manual instructions.
- **Output only in chat**: Do not create or write result files; all output is in the reply.
- **Overrating**: Default to questioning High/Critical; require clear impact (e.g. % daily volume or many flows) and likelihood.
- **Severity discipline**: Assess likelihood for the full attack path (all required conditions in conjunction). When impact or likelihood cannot be validated, ask the user rather than stating an unvalidated severity.
- **Severity reasoning in output**: Always produce the dedicated **Severity reasoning** section (Impact + why, Likelihood + why, required conditions, resulting severity). Do not only state the final severity; the reviewer must be able to follow why that level was chosen.
- **Impact for subset-at-risk**: When only a subset of value is at risk (e.g. positive slippage, not principal), treat impact as **Low** or **borderline Low/Medium** and explicitly **challenge the rating** in the output so the user can confirm. Use a quick web search for current volume (e.g. "li.fi monthly volume") when grounding impact in absolute terms; do not hardcode figures. When any self-obtained volume was used, **print it in the Severity reasoning section** under "Volume assumption (if used)" (e.g. assumed monthly volume and source).

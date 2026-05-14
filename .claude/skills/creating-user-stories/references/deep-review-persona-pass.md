# Deep review — multi-agent persona pass (escalation only)

Load this only when escalating beyond the SKILL.md "lightweight three-lane review". The deep review surfaces ~50 findings of which ~10 are real product decisions and ~15 are SC technical questions — the remaining ~25 are noise. Account for the noise tax before running.

## When to escalate

Trigger the deep review only when:
- The catalogue is going into a high-stakes audit (third-party with substantial engagement).
- The product has truly bimodal users (e.g. compliance-heavy AND DeFi-native integrators with very different needs).
- An incident or near-miss revealed a class of finding the lightweight review missed.

Default to the lightweight three-lane review. Most catalogues (~50–80 stories) don't need this.

## Standard persona set (5 agents, run in parallel)

Use named personas (named produces sharper findings than generic "Reviewer #1"). Adapt names to the product domain, keep role coverage:

1. **Integrator** (e.g. "Maya Chen, Head of DeFi Partnerships at a DeFi-native fintech") — runs a product team, ships white-labeled yield products. Reviews integrator + cross-cutting stories.
2. **Internal admin / product operator** (e.g. "Alex Lee, Earn Product Lead") — runs the protocol day-to-day, holds emergency keys, manages BD pipeline. Reviews admin + scale/crisis/compliance.
3. **Sophisticated end user** (e.g. "Jordan Park, $500k DeFi power user with Safe wallet") — reads contract source before depositing, skeptical, MEV-aware. Reviews user + trust/exit/MEV.
4. **Senior SC dev / DeFi expert** (e.g. "Vlad Petrov, ex-Trail-of-Bits") — reads PRD + research notes + comparable-product audits. Reviews technical + audit-readiness.
5. **PM owning the PRD** (e.g. "Priya Shah, Senior PM") — strict gatekeeper, owns PRD-traceability, fights scope creep. Reviews PRD-coverage matrix + scope departures.

**On agent count**: 5 is the default. Add a 6th adversarial reviewer (hostile auditor, regulator, MEV attacker) only for high-stakes pre-audit. Add a 2nd integrator (compliance-focused) only if the product has truly bimodal integrator types.

## Required agent-prompt structure

Every agent prompt must include:
- **Persona briefing**: name, role, background, what they care about, what they've been burned by (1–2 paragraphs).
- **Required reading**: exact URLs / file paths. Don't assume the agent can guess.
- **Task** with 4–6 explicit categories of finding to look for.
- **Output format**: numbered list, capped at 10–15 findings, with severity (S1 blocker / S2 high / S3 medium / S4 polish) and cost-to-fix (XS/S/M/L) tags per finding.
- **Word cap**: 500–900 words depending on agent scope.
- **High-signal only**: do NOT pad with "this looks good" notes.
- **Propose, don't apply**: agent recommends actions; does NOT edit the catalogue.

Findings format per agent:
```
**Finding-N**: [Category] [SeverityTag] [Cost-tag] — one-sentence description — suggested action
```

## Consolidation procedure (operator's job)

After all agents return:

1. **Route each finding into the three lanes** (PRD coverage / product decision / SC technical) — same lanes as the lightweight review. Findings that don't fit a lane are noise — drop them.
2. **Tag consensus signals.** Findings flagged by 2+ agents get a `[consensus]` tag — highest confidence, raise to top.
3. **Scope-tension report.** Findings that add capability conflicting with findings that remove capability get flagged. Force explicit user decision.
4. **All findings are proposals**, not auto-applied. Human-in-the-loop accept/dismiss.

## Mandatory consistency check

Run SKILL.md's standard verification (phantom Qs, orphan Qs except `[META]`, cross-reference resolution, ID gaps, counts footer). Clean-or-violations report.

## Meta-review (mandatory final step)

After consolidation, before next review:

1. **Did each agent's findings actually differ?** If two agents found the same things, persona briefings weren't differentiated enough.
2. **Did the persona set cover all relevant lenses?** Did consolidation reveal a class no agent caught?
3. **Were the word/finding caps right?** Too low = misses; too high = noise.
4. **Were consensus signals reliable?** If a triple-consensus finding turned out wrong, prompts may bias toward false agreement.
5. **What scope-tensions surfaced?** Many conflicts → PRD may be ambiguous, feed back to PM.

Output: short note in operator's review log, NOT inline in the catalogue.

## Anti-patterns

- **Treating deep-review findings count as success.** ~25 of ~50 will be noise. The output of a good review is a short list of decisions you need, not a long list of things to think about.
- **Letting agents see each other's reports.** Independence is the value. Sequence only if you have a specific consolidation step between (and even then, don't show prior findings).
- **Skipping the meta-review.** The meta-review is what makes the next review better. Without it, the same blind spots recur.
- **Running deep review as the default** instead of the lightweight three-lane review. Optimizes for finding things, not for finding decisions.

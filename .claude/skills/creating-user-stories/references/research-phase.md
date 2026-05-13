# Research phase — recipe, subagent template, worked examples

Load when running the research phase from `SKILL.md`. Carries the subagent prompt template + three worked examples (one SC, one DevOps tool, one API/dev-product) so the genericity claim is concrete, not asserted.

## Subagent prompt template (domain-agnostic)

Each comparable gets one subagent dispatched in parallel. Standard agent brief:

```
You are researching <COMPARABLE_NAME> as a comparable for the
<PROJECT_NAME> design. Your role in the comparable set is
<ROLE: blueprint | marquee-customer-reality | competitor | field-wide
       | adjacent-but-distinct>.

CONTEXT (1–2 paragraphs):
- What we're building (1 sentence).
- Why this specific comparable is in the set (1 sentence).
- What downstream work this research feeds (audit / estimate / review).

REQUIRED READING (primary sources only):
- <docs URL>
- <source repo / verified contract / public spec>
- <governance archive / incident post-mortem / RFC>
- <data dashboard / dune / public usage stats if relevant>
Do NOT pad with secondary sources (blog posts about the product, listicles).
If a primary source isn't available for a claim, mark it "unverified."

SCOPE — answer 4–7 of these, picking the ones load-bearing for our design:
- Architecture & topology
- Pricing / monetization mechanism
- Permissioning / access control
- Failure-mode handling (degraded state, recovery, key-loss, migration)
- Public incident history
- Governance / change-control / upgrade model
- Observability / event model / API surface for integrators
- Composition story (who builds on top; integration interfaces)
- Known weaknesses / community-flagged anti-patterns

OUTPUT:
- Structured markdown, ~300–500 lines, primary-source citations inline.
- Final section: "Unverified items" — list every claim you couldn't verify
  against a primary source. Don't fabricate. Better to leave a gap than
  to invent.
- Closing frame (MANDATORY, exactly 3 lines):
    COPY: <what to mirror>
    IMPROVE: <what to do a stronger version of>
    AVOID: <what to invert / not repeat>

CONSTRAINTS:
- You are one of N parallel subagents. Don't reference other agents'
  findings; you can't see them.
- Cap your output at <WORD_BUDGET> words. Be dense.
- Don't propose stories for <PROJECT_NAME>. Your job is the comparable.
  The operator does the synthesis.
```

Tune `<WORD_BUDGET>` to the comparable's depth (800 for blueprint, 400 for adjacent-but-distinct).

## Synthesis output template — `research-analysis.md`

```markdown
# Research Analysis — Comparable Products

Background for <PROJECT_NAME> design. Compiled <DATE> from primary sources.
Raw per-comparable research in [`raw/`](raw/).

## A. <Comparable 1 name> — the explicit blueprint
[~300 words: architecture, primary mechanism we care about, fee/auth/pricing,
governance, known weaknesses. Lift from raw/01.]

**COPY**: ...
**IMPROVE**: ...
**AVOID**: ...

## B. <Comparable 2 name> — marquee-customer reality
[Same shape.]

...

## Cross-cutting findings
1. [Pattern visible across ≥2 comparables: e.g. "all converged on
   factory + immutable-per-instance + timelocked-mutable-params."]
2. [Repeated anti-pattern: e.g. "every competitor with a single global
   upgrade key has had at least one near-miss."]
3. [Convergent constraint: e.g. "every product in this space ships
   without an X capability — confirms X is V2/V3 territory."]
```

The cross-cutting section is where the value compounds — convergence across independent subagents is a high-confidence signal.

---

## Worked Example A — Smart-contract design (SC)

**Project**: LI.FI Programmable Vault Wrapper (an ERC-4626 wrapper factory + clone topology).

**Comparable set**:

| Role | Comparable | Why |
|---|---|---|
| Explicit blueprint | Kiln Omnivault | PRD names it: "clone of the Kiln pattern" |
| Marquee-customer reality | Coinbase USDC Earn (Morpho/Steakhouse + Merkl stack) | Coinbase is named in the PRD; their actual on-chain stack matters more than what they say they want |
| Field-wide | Morpho MetaMorpho / Yearn V3 / Veda / Lagoon / Mellow / Superform / Sommelier / Idle | 8-row table across the EVM 4626/7540 wrapper landscape |
| Competitor (deferred — no dedicated agent) | Yield.xyz | Folded into field-wide; primary sources thin |
| Adjacent-but-distinct (deferred) | Aave Pool / Compound Comet | Not wrappers; the underlying primitive |

Realised output: see `earn-monetization-v2-vault-wrapper/raw/{01,02,03}-*.md` + `research-analysis.md` in the same folder. Three subagents (Kiln deep-dive, Coinbase reward-injection deep-dive, similar-products comparison) plus two follow-on synthesis agents (research-derived stories, ambiguities). The two synthesis-agent outputs (`04-user-stories.md`, `05-open-questions.md`) demonstrate the next step — research feeds drafting directly.

**Cross-cutting findings that drove the actual catalogue**:
1. Converged architecture skeleton: factory + immutable-per-instance + timelocked-mutable-params + guardian-veto (Morpho, Yearn V3, Lagoon). Drove A1–A3 of the final catalogue.
2. Perf-fee cap encoded in implementation is the integrator-trust primitive — Morpho caps at 50%, Kiln has no cap. Drove A11 (immutable bytecode cap) + Q1.10 (distinct from factory-tunable cap).
3. Two viable reward-injection shapes: harvest-and-reinvest into NAV vs external distributor decoupled from share accounting. Drove I10, I11, I15 + the entire reward-injection Q-section.

---

## Worked Example B — DevOps / internal tooling

**Project**: an internal on-call scheduling + paging tool (replacing a "we use a Slack channel and pray" status quo for a 50-engineer org).

**Comparable set**:

| Role | Comparable | Why in the set |
|---|---|---|
| Explicit blueprint | PagerDuty | The category-defining product; the spec references it |
| Marquee-customer reality | The engineering team's current state (Slack + a shared Google Sheet rotation) | What they actually do today, not what they think they do |
| Dominant competitor | Opsgenie (Atlassian) | The "if not PagerDuty, then this" |
| Field-wide | PagerDuty / Opsgenie / VictorOps / Squadcast / Better Stack / Rootly / Incident.io | 7-row table |
| Adjacent-but-distinct | Slack-native incident bots (e.g. Slack Huddles + Workflow Builder) | Solves the "page someone" half but not the "schedule rotations" half |

**What the comparables differ on (the design's load-bearing axes)**:
- Rotation expression language (custom DSL vs override-on-top-of-recurring-rule vs ICS calendars).
- Escalation policy semantics (timed escalations vs explicit acknowledge vs hybrid).
- "Who's on-call right now?" API surface (REST vs Slack-slash vs both).
- Integration model (webhooks / push connectors / iPaaS).
- Audit / compliance posture (SOC2-relevant action log).

**COPY/IMPROVE/AVOID examples** (per comparable, illustrative):
- *PagerDuty COPY*: timed-escalation with explicit acknowledge semantics; this is the load-bearing primitive.
- *PagerDuty IMPROVE*: the rotation-expression DSL is too powerful for our scope — ship a smaller declarative surface.
- *PagerDuty AVOID*: pricing model is per-user-per-month; for internal we ignore.
- *Current-state AVOID*: nobody knows who's on-call without a Slack scroll — primary capability the design must solve.

**Cross-cutting findings the operator would actually carry forward**:
1. Every product converges on "rotation × escalation × notification channel" as the core data model.
2. Every public incident review of an on-call tool failure traces to "notification channel was misconfigured" (SMS down, phone-on-DND, the notified person was already on PTO). Drives an "active-watcher health check" capability into V1.
3. Adjacent-but-distinct (Slack-only) makes the case for *not* shipping a paging primitive in V1 if Slack alerting + a single shared escalation policy is enough.

Same skill, same recipe, different domain. The COPY/IMPROVE/AVOID frame ports unchanged.

---

## Worked Example C — Developer-product API design

**Project**: an internal-platform feature-flag service for a 30-product company (replacing a homegrown env-var dance + a half-built admin tool).

**Comparable set**:

| Role | Comparable | Why |
|---|---|---|
| Explicit blueprint | LaunchDarkly | The category leader; the spec references it |
| Marquee-customer reality | The web platform team's current state (env vars + a wiki of flag definitions) | The team most painful to migrate; their workflow drives the requirements |
| Dominant competitor | Statsig | The "if not LaunchDarkly, then this"; bundles experimentation |
| Field-wide | LaunchDarkly / Statsig / Unleash / GrowthBook / ConfigCat / Flagsmith / PostHog Feature Flags | 7-row table |
| Adjacent-but-distinct | OpenFeature (spec, not a product) | Forces the question: do we adopt the open standard's interface, or invent our own? |

**Load-bearing design axes the comparables differ on**:
- SDK model (server-side fetch vs streaming vs local-evaluation with rule sync).
- Targeting-rule expression (DSL vs JSON vs visual builder).
- Evaluation latency (cached-locally vs round-trip per flag).
- Multi-environment model (env-as-property vs env-as-namespace).
- Audit-log shape (per-flag history vs global event stream).
- Kill-switch semantics (per-flag vs global vs none).

**COPY/IMPROVE/AVOID examples**:
- *LaunchDarkly COPY*: local-evaluation SDK with background rule sync — the latency profile is non-negotiable for hot paths.
- *LaunchDarkly IMPROVE*: targeting-rule DSL is rich but undocumented; ship a smaller surface with a public grammar.
- *LaunchDarkly AVOID*: per-MAU pricing distorts product usage (teams stop putting low-traffic features behind flags).
- *OpenFeature COPY*: provider interface — even if we don't adopt it as our public API, our internal SDK should conform so we can swap providers later.
- *Statsig AVOID*: bundling experimentation with feature flags couples two unrelated lifecycles.

**Cross-cutting findings**:
1. Every product offers local-evaluation; round-trip-per-flag is dead. Confirms V1 architecture.
2. Every product publishes an audit log; only some publish it as a stream consumable by SIEM tools. Drives a "stream the audit log" V1 requirement for the platform team's security review.
3. OpenFeature's existence means inventing a non-conforming public API has a known future-cost; conforming has near-zero present-cost. Easy V1 decision.

---

## Anti-patterns (cross-domain)

- **One subagent doing all comparables.** Loses parallel-independence value; introduces correlated bias.
- **Reading other agents' outputs mid-flight.** Convergent answers look like consensus but are correlation. Read after all return.
- **Citing secondary sources.** "A Medium post says LaunchDarkly does X" is not a source — LaunchDarkly's docs or a public RFC is.
- **Skipping COPY / IMPROVE / AVOID.** Research becomes a wiki; you can't trace catalogue items back to a decision input.
- **Research after drafting is locked.** Re-opens the catalogue and erodes the audit trail. Run in parallel with — or just before — initial drafting.
- **Padding the comparable set.** Below 3 = no triangulation; above 5 = the operator can't hold the synthesis. Resist "and we should also look at …" when the set is already at 5.
- **Letting the blueprint dominate the synthesis.** Every other comparable should pull weight; if the blueprint accounts for >60% of the catalogue's research-derived content, the comparable set was mis-picked.

## When to skip the phase entirely

The trigger is "feeds high-stakes downstream work." Some catalogues genuinely don't:
- Internal team-alignment doc that nobody outside the team will read.
- Quick spec-extraction for a small feature with no third-party dependencies.
- A catalogue refresh after the original research is still fresh (<6 months).

In these cases, run the workflow without the research phase. The catalogue will be 20–30% thinner on edge cases but that's the right trade-off when no downstream reviewer demands the coverage.

---
name: sc-design-review
description: Multi-agent senior smart contract design review starting from a Product Requirements Document (PRD). Ingests a PRD (Notion URL, Notion page ID, or local markdown file), runs an ambiguity gate, drafts a tech-lead-grade smart contract design doc, then hardens it across up to three rounds of structured challenge by a panel of senior engineering personas (DeFi/composability, EVM/low-level, cross-chain, security auditor, QA, product lead). Use this skill whenever a user wants a smart contract design, technical specification, contract estimate, contract architecture, or threat model derived from a product spec — even if they don't say "skill" or "design review". Trigger on phrases like "design a smart contract for…", "I have a PRD for a contract…", "review the SC design for…", "build me a contract spec from this Notion doc", "estimate this smart contract", or any request that supplies a product spec and asks for a contract-level technical answer. Security is the dominant quality attribute — the skill funnels toward security/correctness, not consensus.
---

# Smart Contract Design Review

A senior smart contract tech lead, with a panel of specialist challengers, reviewing a PRD and producing a hardened design document.

## When to use

Use this skill when:

- A user supplies a product spec (Notion link, page, or markdown) and asks for any of: a smart contract design, technical specification, architecture, threat model, gas notes, or implementation estimate.
- A user asks "what would the contract look like for X" given a feature description.
- A user wants to challenge or harden an existing draft SC design against a PRD.

Do **not** use this skill for:

- Reviewing existing deployed contract code (use a code review skill instead).
- Generic spec review unrelated to smart contracts.
- One-line questions answerable without a structured panel.

## Relationship with `creating-user-stories`

This skill consumes a PRD and produces a hardened smart contract design. The sibling [`creating-user-stories`](../creating-user-stories/SKILL.md) skill consumes the same PRD and produces a structured user-stories + open-questions catalogue as an intermediate artifact.

**When both are run** (recommended for any non-trivial PRD): `creating-user-stories` runs first against the PRD; this skill ingests **both** the PRD and the resulting catalogue. The catalogue's open-questions feed the ambiguity gate (many gaps are already enumerated), and the stories pin capability scope so the Tech Lead doesn't have to re-extract it from PRD prose.

**When only this skill runs**: the design pass still works against a raw PRD. The ambiguity gate has more work to do. For small features (≤ 5 stories) this is fine; for anything larger, running `creating-user-stories` first is strongly recommended — and the orchestrator will prompt for it (see Phase 0).

## Workflow overview

The skill runs a 6-phase orchestration. **Read this section in full before starting** — the order and the gates matter.

```
[Phase 0] Ingest PRD (+ optional stories catalogue)
              │
              ├─► [Phase 1]   Ambiguity gate ──► HALT + ask human (material gaps)
              │
              └─► [Phase 1.5] Research phase (parallel with ambiguity gate)
                                  │
                                  ▼
          [Phase 2] Draft v1 (Tech Lead receives PRD + ambiguity report
                              + research output + optional stories catalogue)
                                  │
                                  ▼
          [Phase 3] Round 1 (full panel) ──► synthesise → v2
                                              │
                                              └─► early-exit possible
                    Round 2 (full panel) ──► synthesise → v3
                    Round 3 (security + QA only) ──► synthesise → v_final
                                  │
                                  ▼
          [Phase 4] Output ──► always write markdown locally
                          ──► ASK the executor: also create a Notion page?
```

## Phase 0 — Ingest the PRD (and optional stories catalogue)

**Input forms accepted:** Notion URL, Notion page ID, local markdown path. The executor may pass a second argument pointing at a stories + open-questions catalogue (from `creating-user-stories`).

1. **PRD ingestion**:
   - If Notion: use `notion-fetch` (or the Notion MCP equivalent) on the page. Then recursively follow links to child pages **up to depth 2**. Stop at depth 2 to avoid runaway. Capture the full content as a single concatenated source string.
   - If local file: read it directly.
2. **Stories-catalogue ingestion (optional)**:
   - If the executor supplied a catalogue link / path: fetch both the Stories page and the companion Open Questions page (sibling pages produced by `creating-user-stories`). Concatenate into `stories_source`.
   - If not supplied **and** the PRD describes a non-trivial feature (>5 distinct capabilities visible): ask the executor once: *"This looks substantial. Has `creating-user-stories` been run against this PRD? If yes, paste the catalogue link; if no, consider running it first — it will sharpen the ambiguity gate and the Phase 2 draft."* Wait for an answer. Either proceed without the catalogue or pause for it.
3. Record:
   - PRD source URL or path (cited in the final doc).
   - PRD title.
   - Stories-catalogue source URL or path (cited in the final doc when present).
   - Date of ingestion (today's date).
4. If the PRD is empty, behind auth, or fetch fails: stop and tell the user.

## Phase 1 — Ambiguity gate

**Why this exists:** smart contract specs that proceed on assumed intent are how exploits are born. Spending six personas across three rounds debating an under-specified spec is wasteful; it is also dangerous because the personas will paper over the gaps with plausible-sounding assumptions that nobody validated.

Invoke the **Tech Lead persona** (`personas/tech-lead.md`) with a single instruction: produce an *ambiguity report* against the PRD. If a stories catalogue is in scope, pass it too — the Open Questions page often pre-enumerates ambiguities the Tech Lead would otherwise re-derive, and items already resolved by stories are not gaps.

The ambiguity report must classify findings as:

- **Material gap** — the contract cannot be designed without resolving this (e.g. "is this contract custodial?", "which chains?", "who can pause?").
- **Minor gap** — design can proceed with a reasonable default, but flag it.
- **Conflict** — two parts of the PRD contradict each other.

**Decision rule:**
- Any **material gap** or **conflict** → HALT. Surface a clarification questionnaire to the executor and stop. Do not proceed to drafting.
- Only minor gaps → proceed; record them in the design doc's "Open questions" section.

When halting, the questionnaire is a numbered list of crisp questions. Do not write paragraphs; the executor needs to scan and answer.

## Phase 1.5 — Comparable-product research

Runs **in parallel with Phase 1** (ambiguity gate) — both feed Phase 2. Skip only when the ambiguity gate has already HALTed, or when the PRD describes a feature for which the existing codebase already contains a near-canonical pattern (e.g. another LiFi facet with the same shape).

**Why this phase exists:** smart contract designs that proceed without comparable-product research routinely miss failure modes that are public knowledge in the comparables' source / post-mortems / governance archives. ~20–30% of the load-bearing findings in a hardened design (first-depositor inflation, harvest-sandwich MEV, beacon-key landmines, JIT-deposit reward gaming, etc.) come from reading what prior art got wrong. Without research, those findings only surface during external audit — at maximum cost.

**The comparable set — pick 3–5 prior-art systems by role**, not by name:

- **Explicit blueprint** — the system the PRD itself references as "we want one of these."
- **Marquee-customer reality** — what a named target customer actually uses on-chain today (often diverges from what the PRD assumes).
- **Dominant competitor / win-back target** — the system being displaced.
- **Field-wide comparison** — table across 5–10 adjacent systems, shallow per cell but wide; surfaces convergent patterns.
- **Adjacent-but-distinct** — a different problem with related architecture; clarifies what your scope is *not*.

Below 3 you lose triangulation; above 5 the synthesis becomes unmanageable.

**Recipe**:

1. **Dispatch one subagent per comparable, in parallel** (single message, multiple `Agent` tool calls). Each writes a single-topic deep-dive to `<workdir>/research/raw/NN-<comparable>.md`. Standard subagent prompt + full recipe in `references/research-phase.md` — load before dispatching.
2. **Synthesise into `<workdir>/research/research-analysis.md`** — one section per comparable, each closing with a **COPY / IMPROVE / AVOID** three-line summary.
3. **Cross-cutting findings** section at the end of `research-analysis.md` — patterns visible across multiple comparables (convergent architecture, recurring anti-patterns, shared blind spots). This is where the value compounds — independent agents converging on a pattern is a high-confidence signal.

**The COPY / IMPROVE / AVOID frame** is non-negotiable. Without it, research becomes a wiki — interesting but undecidable. With it, every research-derived design choice in Phase 2 can be traced back to a specific prior-art lesson.

**Pass the synthesised `research-analysis.md`** (not the raw subagent outputs) into Phase 2. The Tech Lead's job is design, not research aggregation.

**Anti-patterns**:
- One subagent doing all comparables — loses parallel-independence value.
- Agents reading each other's outputs mid-flight — convergence looks like consensus but is correlation.
- Secondary sources only (blog-about-product instead of product docs / source / governance / post-mortems).
- Skipping COPY/IMPROVE/AVOID — research becomes reference material, not design input.

## Phase 2 — Draft v1

Invoke the **Tech Lead persona** with the PRD + ingestion metadata + the ambiguity report + the research synthesis + the stories catalogue (if present). It must produce design doc v1 conforming to `templates/design-doc.md`.

**Mandatory in v1:** all section headers from the template, even if a section reads "TBD — to be challenged in round 1". The challengers will fill in via critique. Section 13 (Custody of funds) must take an explicit position — silence is not acceptable. Design choices that came from comparable-product research should cite the COPY / IMPROVE / AVOID source inline (e.g. *"per `research-analysis.md` §A: AVOID Kiln's global beacon — use per-deploy immutable args."*).

## Phase 3 — Challenge rounds

### Structured handoff contract

Each challenger returns findings as a JSON array conforming to `templates/finding.schema.json`. Free prose is **not accepted** — prose findings cannot be reliably synthesised across six personas. The schema is small: `{id, severity, category, claim, evidence, suggested_change}`. Severity is one of `critical | high | medium | low | info`.

### Round 1 — full panel (6 challengers in parallel)

Spawn in **a single message with six `Agent` tool calls** (parallel execution; do not serialise). Each gets:
- The full PRD source.
- Design doc v1.
- Their persona prompt from `personas/`.
- Instruction: "Return findings as a JSON array per `templates/finding.schema.json`. No prose."

The six challengers:
1. DeFi / Composability Engineer — `personas/defi-composability.md`
2. EVM / Low-level Engineer — `personas/evm-lowlevel.md`
3. Cross-chain / Bridge Engineer — `personas/crosschain-bridge.md`
4. Security Auditor — `personas/security-auditor.md`
5. QA / Verification Engineer — `personas/qa-verification.md`
6. Product Lead — `personas/product-lead.md`

### Synthesis 1 → v2

Invoke the **Tech Lead persona** with:
- Design doc v1.
- All six finding arrays.
- Instruction: produce v2 plus a synthesis note for the executor showing aggregate counts (`N critical, M high, …`) and notable conflicts between challengers. The detailed accept/reject log is **not** persisted in the doc (per the approved spec) — it lives only in this synthesis turn for the executor to read.

### Early-exit check

If round 1 produced **no critical and no high** findings, the Tech Lead may declare the design *stable* and skip directly to Phase 4. State the rationale clearly.

### Round 2 — full panel

Same six challengers, against v2. Devs are needed here too: a v2 that fixes a security finding may have introduced a different implementability problem, and the dev personas catch that.

Synthesise → v3. Apply the same early-exit rule.

### Round 3 — adversarial hardening

Only **Security Auditor** and **QA / Verification Engineer**. The intent is hardening, not new features. The dev and product personas are excluded so they cannot reopen settled scope decisions in the final round.

Synthesise → v_final.

### Final gate

If v_final still contains an **unresolved critical** security finding (Tech Lead chose to defer rather than address), the doc's status is `BLOCKED — security review`. Failing to ship is a valid output; shipping a known-critical design is not.

Otherwise: `READY`.

## Phase 4 — Output

1. **Always** write `<prd-title-slug>-design-v<final>.md` to the working directory (or to a project-specific folder if the repo's `CLAUDE.md` defines one). Do not write outside the current repo.
2. **Always** prompt the executor (the human running the skill): "Also create a Notion page for this design doc? (yes/no, and parent page ID if yes)". Do not assume; do not silently flag.
3. If yes: use `notion-create-pages` under the supplied parent. Include the source PRD link in section 0.

## Persona invocation pattern

Personas are invoked via the `Agent` tool with `subagent_type: general-purpose`. The persona prompt file is read and inlined into the subagent's prompt. There is no permanent agent definition — these personas only exist within this orchestration.

When invoking a challenger:

```
Agent(
  subagent_type: "general-purpose",
  description: "<Persona name> reviewing v<N>",
  prompt: <contents of personas/<file>.md>
        + "\n\n## PRD\n" + prd_source
        + "\n\n## Design doc to review\n" + draft_vN
        + "\n\n## Output\nReturn ONLY a JSON array per templates/finding.schema.json. No prose."
)
```

When invoking the Tech Lead for synthesis:

```
Agent(
  subagent_type: "general-purpose",
  description: "Tech Lead synthesis round <N>",
  prompt: <contents of personas/tech-lead.md>
        + "\n\n## Current draft\n" + draft_vN
        + "\n\n## Findings to weigh\n" + concatenated_finding_arrays
        + "\n\n## Output\nProduce draft v<N+1> conforming to templates/design-doc.md, plus a one-paragraph synthesis note for the executor."
)
```

## Failure modes to avoid

- **Rubber-stamping**: if every round produces only `info` and `low` findings, suspect persona prompts have gone toothless. Re-read them.
- **Ambiguity laundering**: if the Tech Lead in Phase 2 silently assumes away gaps the ambiguity gate flagged as material, the gate failed. The Tech Lead persona must refuse to proceed when handed a material-gap report.
- **Late-stage scope creep**: in round 3, if security or QA proposes new features, ignore the proposal and downgrade to suggested follow-up work. Round 3 is for hardening only.
- **Notion runaway**: never recurse Notion fetches deeper than depth 2.
- **Subagent serial execution**: per-round challengers MUST be spawned in parallel (single message, multiple tool calls). Serialising them wastes time and breaks the parallel-perspective premise.

## Reference files

- `personas/tech-lead.md` — synthesis owner
- `personas/defi-composability.md` — DeFi composition lens
- `personas/evm-lowlevel.md` — EVM/storage/gas lens
- `personas/crosschain-bridge.md` — cross-chain lens
- `personas/security-auditor.md` — adversarial lens
- `personas/qa-verification.md` — testability lens
- `personas/product-lead.md` — requirements completeness lens
- `references/research-phase.md` — Phase 1.5 recipe: subagent prompt template, synthesis template, worked example. **Load before dispatching research subagents.**
- `templates/design-doc.md` — final deliverable structure
- `templates/finding.schema.json` — challenger output contract
- `scripts/orchestrate.md` — turn-by-turn runbook (read this before executing)

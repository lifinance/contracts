# Orchestration runbook

This is the executable runbook for the orchestrator (i.e. the Claude session running this skill). Read it top-to-bottom; do not skip steps.

---

## Step 1 — Resolve input (PRD + optional stories catalogue)

Inputs accepted: Notion URL, Notion page ID, local markdown path. Optional second input: stories-catalogue link / path produced by `creating-user-stories`.

**PRD ingestion**:
- If Notion: call `notion-fetch` on the page. For each child page link discovered, fetch it too. Stop at depth 2. Concatenate all page contents into `prd_source` with section headers per page.
- If local: read the file. `prd_source` is the file content.
- Capture `prd_title`, `prd_link` (URL or absolute path), `ingested_at` (today).

**Stories-catalogue ingestion (optional)**:
- If a catalogue link / path was supplied: fetch the Stories page **and** the companion Open Questions page (`creating-user-stories` produces both as siblings). Concatenate into `stories_source`. Capture `stories_link`.
- If not supplied and the PRD has >5 distinct capabilities (rough heuristic: >5 third-level headings or >5 numbered "the system shall" / "users can" assertions): ask the executor once: *"This PRD looks substantial. Has `creating-user-stories` been run against it? Paste the catalogue link if yes; otherwise consider running it first."* Wait for the answer. Proceed without if declined; otherwise ingest as above.
- If catalogue ingestion fails for any reason: continue without it, do not block on this.

If `prd_source` is empty or fetch failed, stop and tell the user. Do not silently proceed.

## Step 2 — Phases 1 + 1.5 (in parallel): Ambiguity gate + Research phase

Spawn **both** subagent sets in **a single message**:

1. **One Tech Lead subagent in Mode A** (ambiguity gate):

```
Agent(
  subagent_type: "general-purpose",
  description: "Tech Lead — ambiguity gate",
  prompt: <personas/tech-lead.md>
        + "\n\n## Mode\nA — Ambiguity gate"
        + "\n\n## PRD\n" + prd_source
        + (stories_source ? "\n\n## Stories catalogue (treat resolved items as NOT gaps)\n" + stories_source : "")
        + "\n\n## Output\nProduce the ambiguity report per the persona prompt. End with material_gaps: <true|false>."
)
```

2. **N research subagents** (3–5; one per comparable). Load `references/research-phase.md` first; pick the comparable set per its "roles, not products" recipe; dispatch each with the standard prompt template from that reference. Each writes to `<workdir>/research/raw/NN-<comparable>.md`.

Both blocks run in parallel — they don't depend on each other. Don't wait for the ambiguity gate before starting research.

**Decision after both return**:
- If `material_gaps: true`: print the questionnaire to the executor. Stop. The research output is still useful when the executor returns with answers — save the `raw/` files for the next run.
- If `material_gaps: false`: synthesise the research into `<workdir>/research/research-analysis.md` per the recipe in `references/research-phase.md` (one section per comparable, COPY/IMPROVE/AVOID per comparable, cross-cutting findings section at end). Keep both the ambiguity report and the synthesised analysis in scope for Step 3.

## Step 3 — Phase 2: Draft v1

Spawn one Tech Lead subagent in Mode B:

```
Agent(
  subagent_type: "general-purpose",
  description: "Tech Lead — drafting v1",
  prompt: <personas/tech-lead.md>
        + "\n\n## Mode\nB — Drafting"
        + "\n\n## PRD provenance\nTitle: " + prd_title
        + "\nSource: " + prd_link
        + "\nIngested: " + ingested_at
        + (stories_link ? "\nStories catalogue: " + stories_link : "")
        + "\n\n## PRD\n" + prd_source
        + (stories_source ? "\n\n## Stories catalogue\n" + stories_source : "")
        + "\n\n## Ambiguity report (minor gaps to flag in §12)\n" + ambiguity_report
        + "\n\n## Comparable-product research synthesis\n" + research_analysis
        + "\n\n## Output\nProduce design doc v1 per templates/design-doc.md. Fill Section 0 (Source PRD) using the provenance fields above. Section 13 (Custody of funds) MUST take an explicit position. Design choices derived from comparable-product research should cite the COPY/IMPROVE/AVOID source inline."
)
```

Save output as `draft_v1`.

## Step 4 — Round 1: full panel (parallel)

Spawn six challengers in **a single message with six `Agent` tool calls**. Do not serialise.

For each challenger persona file in `personas/{defi-composability,evm-lowlevel,crosschain-bridge,security-auditor,qa-verification,product-lead}.md`:

```
Agent(
  subagent_type: "general-purpose",
  description: "<Persona> — round 1 challenge",
  prompt: <persona file contents>
        + "\n\n## PRD\n" + prd_source
        + "\n\n## Design doc to review\n" + draft_v1
        + "\n\n## Output\nReturn ONLY a JSON array of findings per templates/finding.schema.json. No prose, no preamble, no explanation. Array must be parseable by JSON.parse."
)
```

Collect six finding arrays. If any challenger returned non-JSON, request a clean retry from that one challenger only.

## Step 5 — Synthesis 1 → v2

Spawn one Tech Lead subagent in Mode C:

```
Agent(
  subagent_type: "general-purpose",
  description: "Tech Lead — synthesis round 1",
  prompt: <personas/tech-lead.md>
        + "\n\n## Mode\nC — Synthesis"
        + "\n\n## Current draft (v1)\n" + draft_v1
        + "\n\n## Findings\n" + JSON.stringify(all_six_arrays, null, 2)
        + "\n\n## Output\n1) Updated draft v2 conforming to templates/design-doc.md. 2) A synthesis note (≤200 words) for the executor with aggregate finding counts and notable conflicts."
)
```

Save output as `draft_v2` and `synthesis_note_1`. Print `synthesis_note_1` to the executor.

## Step 6 — Early-exit check

If round 1 produced **0 critical and 0 high** findings across all six arrays:
- Tech Lead may declare stable. Set `draft_final = draft_v2` and ensure its status header reads `READY` (instruct the Tech Lead persona to set it explicitly if missing). Skip to Step 11.
- Print rationale.

Otherwise: continue.

## Step 7 — Round 2: full panel (parallel)

Same as Step 4 but against `draft_v2`. Collect six finding arrays.

## Step 8 — Synthesis 2 → v3

Same as Step 5 but with v2 as input. Produce `draft_v3` and `synthesis_note_2`.

Re-check early-exit (no critical, no high) — if clean, set `draft_final = draft_v3`, ensure its status header reads `READY` (set it explicitly if missing), and skip to Step 11.

## Step 9 — Round 3: adversarial hardening (security + QA only)

Spawn **two** challengers in parallel (single message, two tool calls): security-auditor and qa-verification, against `draft_v3`. Use the same prompt pattern as Step 4 but with an extra instruction: "Do not propose new features. This round is hardening only. Scope-creep findings will be downgraded to `info`."

## Step 10 — Synthesis 3 → final

Same as Step 5, with v3 + the two round-3 arrays. Produce `draft_final` and `synthesis_note_3`.

### Final gate

Inspect `draft_final` for any unresolved critical-severity finding from round 3 that the Tech Lead deferred. If present, set the doc's status to `BLOCKED — security review`. Otherwise `READY`.

## Step 11 — Output

1. Slugify `prd_title` → `<slug>-design-v<final>.md`.
2. Determine output folder:
   - Default: write into the current working directory.
   - If the host repo's `CLAUDE.md` (or equivalent project conventions file) specifies a design-doc location, honour it.
   - Never write outside the current repo or to user-specific absolute paths.
3. Write the final markdown file.
4. **Always ask the executor**: "Final design doc written to `<path>`. Also create a Notion page for it? If yes, what is the parent page ID?" Wait for the answer.
5. If yes: call `notion-create-pages` under the supplied parent. Use `prd_title` + " — SC Design" as the page title. Body = `draft_final`. Confirm the new page URL back to the executor.

## Failure modes — quick reference

- Empty PRD fetch → stop.
- Material ambiguity → stop with questionnaire.
- A challenger returns prose instead of JSON → retry that challenger once.
- Round 1 produces only `info`/`low` → suspect toothless personas; re-read prompts before declaring stable.
- Round 3 challenger proposes new features → ignore the proposal, do not re-open scope.
- Unresolved critical at final → ship as `BLOCKED`. Do not fudge.

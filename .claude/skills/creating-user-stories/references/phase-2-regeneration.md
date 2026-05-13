# Phase 2 — Regenerating the verbose page from simplified

Load this when the catalogue has stabilised (story IDs settled, "so that..." clauses settled, open Qs mostly resolved or candidate-locked) and you're generating the verbose page for the first time. This runs ONCE per catalogue. SKILL.md defaults to Phase 1; you're entering Phase 2 only when explicitly triggered.

## When to enter Phase 2

Triggers:
- Catalogue feels stable (most reviewers agree on story shape).
- Open Qs are mostly resolved or have locked candidate answers.
- Ready to hand off to SC design / audit.

Do NOT enter Phase 2 during ongoing finalisation. The cost of two-page maintenance during a moving target exceeds the benefit.

## Inputs required

- **Simplified user-stories page** — IDs, titles, "so that..." clauses, persona/theme grouping, ❓Q-id markers.
- **Open Questions page** — full text of every Q referenced from a story.
- **PRD** — original product spec, ideally with section numbers.
- **Design review notes** — meeting notes, async discussion threads.
- **Research notes** — comparable-product audits, prior-art surveys.
- **Architectural-decision records** — design discussions that supersede ambiguity ("we decided dual-path authority on date X").

## Step-by-step derivation

For each simplified story `- **A13.** [verb-phrase], so that [why]. ❓[Q4.2](link), [Q4.8](link)`:

1. **Title** — promote the verb-phrase into a title-cased H3 heading. Add `*(research-derived)*` if the story exists because of comparable-product research (not the PRD).

2. **Story** — restate as full "As a [persona], I want to [verb-phrase], so that [why]." sentence. Persona comes from the simplified section header.

3. **Acceptance hints** — generate by reasoning about contract behavior. Pass the "Acceptance-hint quality bar" three-of-six test from SKILL.md.
   - What function(s) get called? Pick names matching the verb-phrase.
   - What events emit?
   - What role checks (`onlyOwner`, `onlyRole(X)`, `msg.sender == address(timelock)`)?
   - What revert conditions and custom errors?
   - What invariants hold afterwards?
   - What's intentionally NOT in scope (and where it lives instead)?

4. **Sub-points (if needed)** — if the story is a "vague umbrella" (gate every X, configure all Y), enumerate sub-items as `A2.1`, `A2.2`, …. Apply the naming-red-flag test.

5. **Source** — cross-check against the PRD using SKILL.md's source-tag table:
   - PRD body with section number → `**Source**: PRD §X.Y`.
   - Design-review notes → `**Source**: ⚠️ Suggested by SC team, decision required`.
   - Your own inference → `**Source**: Inferred`.
   - Comparable-product audit → `**Source**: Research — [protocol comparison]`.
   - Don't launder notes-derived stories as `PRD §X.Y`.

6. **Depends on open Q** — copy from the simplified ❓ markers, expand to `**Depends on open Q**: QX.Y (one-line restatement of the Q's title)`. Pull the title from the Open Questions page.

7. **Provisional flag** (if applicable) — if the simplified page marked the story `*(provisional)*`, transcribe as a full **⚠️ Provisional status** section in the verbose story.

8. **Cross-references** — add `(see AX, IY)` pointers wherever the story interacts with another.

## What requires generative judgment (be honest)

- **Acceptance-hint specifics** (exact function names, event signatures, gas estimates, threshold values) — these are NEW design choices made during regeneration, not extractable from the simplified page. **MUST be reviewed by the SC team before the verbose page is treated as authoritative.**
- **Threat-model framing** for layered controls — re-derive from the open Q's candidate answer.
- **"Who actually benefits" reframings** — re-derive from the architecture (immutability story + slow-path action list).

## Output review checklist before declaring done

- [ ] Every simplified story has a corresponding verbose entry with the same ID.
- [ ] Every "so that..." clause matches between simplified and verbose (no drift).
- [ ] Every `Depends on open Q` references a real Q on Open Questions.
- [ ] No story is sourced as `PRD §X.Y` without a section reference.
- [ ] No story is missing acceptance hints.
- [ ] Sub-points exist for every umbrella-titled story.
- [ ] "Immutable" / "fixed" claims enumerate exceptions.
- [ ] Cross-references resolve.
- [ ] SC team sign-off captured: "acceptance hints reviewed by [name] on [date]".

## Post-Phase-2 alignment

After the verbose page exists, follow the edit-propagation matrix in SKILL.md "Keeping pages in sync":
- New story or wording change → land on simplified first, then propagate to verbose in the same session.
- Open Q resolved → strip ❓ from simplified, remove "Depends on open Q" from verbose, move Q to Resolved.
- Story deleted → remove from both, mark orphaned Qs.

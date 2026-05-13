---
name: creating-user-stories
description: Use when drafting, maintaining, refining, or auditing a structured, audit-ready user-stories catalogue from a PRD + design-review notes + open-questions list. Outputs persona-grouped stories with concrete acceptance hints, source citations, and explicit linkage to unresolved open questions across a simplified + verbose two-phase workflow. Trigger on "write user stories for", "draft stories from this PRD", "expand the user stories", "add a story for X", "audit the catalogue", "clean up the open questions", "refine the stories", or any request to produce or maintain a stories catalogue feeding SC design or audit scoping. Use this skill whenever the user is working on a structured stories catalogue or its companion open-questions page, even if they don't say "user story" explicitly. Skip for casual feature lists or one-off ticket descriptions.
---

# Creating User Stories

## When to use

A **structured, auditable user-stories catalogue** — the kind that feeds an SC design doc, audit scope, or estimate. Not for one-off Jira tickets or casual feature lists.

**Inputs**: PRD, design-review/meeting notes, open-questions list (or create one in parallel), optional comparable-product research.

**Output**: a catalogue across 3 pages, 2 phases.

| Phase | Active pages | What's happening |
|---|---|---|
| **Phase 1 — Finalisation (default)** | Simplified + Open Questions | Catalogue in flux. The Verbose page does NOT exist. |
| **Phase 2 — Verbose generation** | Simplified + Open Questions + Verbose | Triggered ONCE the catalogue stabilises. See `references/phase-2-regeneration.md`. |

**Default to Phase 1.** Maintaining two pages during a moving target is high cost / low benefit. Generate Verbose once when stable. If you find a Verbose page started prematurely, archive it (banner + title prefix `📦 [ARCHIVED]`) rather than maintaining both.

## Core principles

1. **One story = one discrete capability.** No "AND" in titles or action clauses. See "One-action-one-benefit grammar".
2. **Acceptance hints are concrete contract behavior** — function names, events, reverts, role checks. Not generic "should work correctly". *(Phase 2 only.)*
3. **Always cite source** in the Verbose page. Phantom citations ("PRD" without §) get challenged. *(Phase 2 only.)*
4. **Surface unknowns, don't hide them.** Story shape that depends on an unresolved decision → mark with `❓Q-id` (Simplified) or `**Depends on open Q**` (Verbose). Never invent an answer.
5. **Research-derived stories** are flagged `*(research-derived)*` in the title.
6. **Stable IDs.** Once assigned, never renumber. Append new at end of theme group with next free number.
7. **Cross-doc alignment is non-negotiable.** Every `❓Q-id` must resolve to a real Q. Phantom Q references erode trust. See "Keeping pages in sync".
8. **PRD is owned by product.** The catalogue surfaces tensions as questions; it never proposes PRD edits. See "PRD ownership rule".
9. **Human-readable framing wins.** Every story and every open Q must read like a sentence a smart PM/engineer would write to a colleague — not a wall of technical jargon. See "Readability format" below.

## Readability format

The catalogue is read by product managers, smart-contract engineers, auditors, and BD. None of them tolerate dense jargon. Apply these rules to **every story body, every open-Q body, every acceptance hint**:

### Phrasing

- **Titles are the actual question / capability**, not category labels. ✓ `What's the hard ceiling on the performance fee an integrator can set?` — ✗ `Maximum performance-fee cap`.
- **One plain sentence per idea.** If a sentence has 3 clauses joined by commas/semicolons, split it.
- **Lead with the decision, not the mechanism.** PM-facing body asks "what should the system do?", not "how does the implementation work?" Implementation goes in acceptance hints, not the story body.
- **Drop filler.** Phrases like "It should be noted that…", "In order to…", "Different UX trade-offs exist…" — strip. Say the thing.

### Labeling multiple options

**Hard rule**: whenever a body presents 2+ discrete options (alternative behaviors, alternative mechanisms, alternative scopes), label them **(a)**, **(b)**, **(c)**, … and have the *Recommendation* / *Candidate* / acceptance hints explicitly reference the chosen letter.

```
*What*: **(a)** integrator-only, **(b)** LI.FI-only, **(c)** permissionless, or **(d)** per-instance allowlist.
*Recommendation*: **(a)** — the integrator owns the wrapper's commercial economics.
```

Reasons:
1. The reader can scan the options in one pass without re-parsing prose.
2. The recommendation is unambiguous — no "the second one" / "permissionless"-style indirection.
3. Sub-questions can reference the letter: "If (b) is chosen, who can update the list?"

When sub-options nest under one parent option, use roman numerals to disambiguate:
```
*Sub-questions if (b)*: (i) who can trigger? (ii) where do proceeds go? (iii) auto-trigger on whitelist removal?
```

**When NOT to label**: single-recommendation bodies (no alternative being considered), TBD entries with no enumerated choices, or one-liners. If you find yourself writing "(a)" alone without a sibling, drop the label.

### Pros / Cons

Add a *Pros* / *Cons* block **only when the trade-off is real and a PM needs to weigh it**. Examples:
- ✓ Q2.12 (V1-vs-V2 scope decision with named partner implications).
- ✗ "Should we use CREATE2?" — has a clear right answer; just label options and recommend.

If you find yourself listing only one Pro or one Con, the trade-off isn't real — delete the section and just recommend.

### Source attribution

- **Open Questions catalogue**: source attribution is optional and lives at the end (`*Source*: ...`). For human-readable versions intended for product review, drop it entirely — the source is recoverable from the page history.
- **Stories (Verbose)**: source is still mandatory per Core Principle 3. The audit trail requires it.

## Structure

### Persona grouping (H2)

- `## As a [Org] admin, I want to...` — IDs start with `A`
- `## As an integrator, I want to...` — IDs start with `I`
- `## As a user (EOA or smart wallet), I want to...` — IDs start with `U`

Adapt for non-SC products (operator / viewer), but keep persona separation.

### Theme sub-grouping (H3)

Within each persona, group by theme. Typical themes for an SC wrapper: Factory & implementation lifecycle / Onboarding & allowlist / Fee economics / Pause & safety / Compliance / Operations & observability / Rewards / Deposit-withdrawal flows / Shares & MEV protection.

### Per-story format

**Simplified** (Phase 1 + Phase 2):
```
- **A1.** [verb-lowercase] [object], so that [why]. ❓[Q4.5](link), [Q9.1](link)
```
Persona phrase is in the H2 heading, not repeated per story. One sentence each, no acceptance hints, no source.

**Verbose** (Phase 2 only):
```
### A1. Short imperative title (or the actual capability phrased as a sentence)
- **Story**: As a [persona], I want to [capability], so that [why].
- **Acceptance hints**: concrete contract behavior — function signatures, events, reverts, role checks. Plain English, one fact per bullet.
- **Source**: PRD §X.Y / Earn PRD Review / Inferred / Research.
- **Depends on open Q**: QX.Y (one-line description). [optional]
```

Variants:
- **Sub-points** (A2.1, A2.2 …) when a story title is an umbrella ("gate every slow-path action") — list every concrete sub-action.
- **Alternative acceptance hints** when an open Q has 2+ plausible answers — show all, label them **(a)** / **(b)** / **(c)** per "Readability format → Labeling multiple options", don't pick prematurely. The candidate (if any) references the chosen letter.
- **Cross-references**: `(see A16)`, `(mirrors I18)` — see "Cross-referencing adjacent-lifecycle stories".

Example of labeled alternative hints:
```
- **Acceptance hints (depends on Q1.3)**:
  - **(a) Virtual-shares dilution** — mint fee-shares to treasury on `harvest()`; PPS reflects post-fee value continuously; emits `FeeAccrued(amount, sharesMinted)`.
  - **(b) Event-based extraction** — transfer fee as ERC-20 on harvest/withdraw; emits `FeeExtracted(recipient, amount)`.
  - **(c) Accumulate-and-sweep** — fee accumulates in wrapper; admin-callable `sweepFees()` transfers to treasury; emits `FeesSwept(recipient, amount)`.
- **Depends on open Q**: Q1.3 — candidate (a). Acceptance hint locks once Q1.3 resolves.
```

## One-action-one-benefit grammar

A user story has exactly two semantic slots: `[verb] [object], so that [benefit]`. Strict rule: **one action, one benefit, no compound verbs in the action clause.**

### Fix patterns

| Smell | Fix |
|---|---|
| `crystallize yield AND split into buckets, so that accounting stays current` | Move AND into the consequence: `trigger harvest, so that accrued yield is crystallized and fees become claimable.` (Both flow from ONE action — acceptable.) |
| `update fee AND emit event, so that...` | Drop the mechanism: `update fee within bounds, so that I can react to market.` Events are implementation. |
| `pause withdrawals AND deposits, so that...` | Two stories OR one composite: `pause the instance, so that...` |
| `do X so that fee accounting stays current` | Sharpen the benefit: `do X so that my accrued balance reflects current yield and I can sweep it.` |

### Acceptable "and"

`trigger harvest(), so that accrued yield gets crystallized AND fees become claimable.` — "and" connects two *outcomes* of ONE action. Fine. Compare to `crystallize AND split` in the action clause = two buttons, both must be pressed.

### Quality check per sentence

1. One verb in the action clause? (`trigger X` / `configure Y` = single verb-object, OK.)
2. The "so that" names a persona-specific stake, not generic "system works"?
3. If "and" appears, is it joining outcomes (downstream of one action), not parallel actions?
4. Reader at risk of conflating with an adjacent-lifecycle story? Add a `(see IX)`.

## Cross-referencing adjacent-lifecycle stories

Two stories on the same concept (fees, rewards, shares, whitelist) at different lifecycle stages can be confused by a reader. Always cross-link with `(see IX)`.

**Common pairings**:
- Crystallize (`harvest()`, I17) vs claim (`claimIntegratorFees()`, I5).
- Configure (`setIntegratorReceivers`, I25) vs apply (claim, I5).
- Inject vs schedule vs distribute vs cancel (I10–I14).
- Allowlist (A5) vs deploy (A8).
- Pause variants — emergency (A13) vs global (A14) vs non-emergency (A15) vs withdrawal (I19).

**Bidirectional** — if A→B is worth linking, B→A usually is. Verify on every edit.

## PRD ownership rule

The PRD is owned by the product team, NOT by the SC team. The catalogue's job:

1. **Surface tensions** when stories drift from PRD or need to add capabilities the PRD doesn't authorize.
2. **Flag tensions as questions for product** with the `⚠️ PRODUCT DECISION NEEDED` tag.
3. **NEVER edit the PRD.** That's a product-team action.

Anti-pattern: writing "Recommend PRD-amend §X.Y to authorize ...". Catalogue role is to *surface the question*, not to *prescribe the answer*.

### Phrasing template for product-decision Qs

Follow the readability format (title is the actual question; options labeled; recommendation references a letter). Two flavors depending on complexity:

**Standard (most Qs)**:
```
**QX.Y — [The actual decision question] — ⚠️ PRODUCT DECISION NEEDED**
*What*: [one-sentence context]. **(a)** ..., **(b)** ..., **(c)** ...
*Recommendation*: **(b)** — [rationale in plain English].
```

**With trade-off (only when a PM must weigh options)**:
```
**QX.Y — [The actual decision question] — ⚠️ PRODUCT DECISION NEEDED**
*What*: [one-sentence context describing the capability and why it's debatable].
*Pros*:
- [specific upside]
- [specific upside]
*Cons*:
- [specific downside]
- [specific downside]
*Recommendation*: **[defer / accept / specific option]** — [rationale].
```

**Anti-patterns**:
- Title as a category label (`Fee mechanism`) instead of a question (`How should the fee mechanism work?`).
- Options listed in prose without (a)/(b) labels.
- Recommendation that doesn't reference one of the labeled options.
- Pros/Cons block with only one bullet on each side — the trade-off isn't real, just recommend.

## Surfacing implicit architectural properties

Some user-visible properties fall out "for free" from architecture and have no explicit story. Readers ask about them first because they're invisible.

**Example**: underlying yield auto-compounds because the wrapper holds underlying-vault shares (it was never withdrawn). Reader sees `harvest()` and asks "where do the funds go?". Architecture provides the property, no story names it → write one:

> **U19.** see my underlying-vault yield auto-compound into my wrapper share price (see I17), so that no claim or reinvest action is needed.

The `(see I17)` traces the property to its mechanical source.

**Litmus test**: when reviewing the catalogue, ask "what questions would a first-time reader have here that the catalogue doesn't answer because the answer is architectural?" If the answer is yes, write the implicit-property story.

## The "naming a story" red flag

If a story title contains a noun that could mean many things (`"upgrade the factory"`, `"manage the allowlist"`), it's too vague. Either:
- (a) Split into multiple concrete stories, or
- (b) Keep the umbrella but enumerate sub-actions A2.1, A2.2, …

Rule of thumb: if a reader can ask "which actions exactly?", you must list them. Most common failure mode in PRD-derived stories — the PRD says "factory is upgradeable" and the story inherits the vagueness.

## Acceptance-hint quality bar

*(Phase 2 only.)*

Bad: "User can deposit and earn yield."
Good: "ERC-4626 conformant; `previewDeposit` / `previewMint` match actual outcome under non-pathological conditions; emits `Deposit`; flash-deposit guard (A16) enforced; reverts if `whitelist` active and `msg.sender ∉ allowlist`."

A hint passes when it answers ≥3 of: function(s) called / state-changes & events / revert conditions / authorization checks / invariants held / what's intentionally out of scope.

**Multiple valid behaviors**: if a hint depends on an unresolved open Q with 2+ plausible answers, list all variants labeled **(a)** / **(b)** / **(c)** per "Readability format → Labeling multiple options". The candidate references the chosen letter; the hint locks when the Q resolves. Don't pick prematurely; don't bury the alternatives in prose.

## Source-tag conventions

*(Phase 2 only — Phase 1 simplified carries no source; source-check happens at regeneration.)*

| Tag | Confidence | Meaning |
|---|---|---|
| `PRD §X.Y` | **Authoritative** | Direct lift from PRD body with section reference. Always cite section number. |
| `⚠️ Suggested by SC team, decision required` | **Tentative** | Surfaced in meeting notes / design discussions. MUST pair with an open Q. |
| `Inferred` | **Guess** | Standard requirement you added not in any input doc. Flag explicitly. |
| `Research` | **External pattern** | Pattern from comparable products. Pair with `*(research-derived)*` in title. |
| `Architectural decision — [topic]` | **Resolved-in-design** | Decision from design discussion that supersedes ambiguity. |

**The PRD-vs-notes trap**: a meeting-notes claim ("we said PartnerPortal would do X") gets transcribed as `Source: PRD — "..."`. The PRD body never said it. By audit time nobody remembers and the assumption is load-bearing. Before writing `Source: PRD §X.Y`, you must point to that section. If you can only point to notes → `⚠️ Suggested by SC team, decision required`. When in doubt, downgrade.

**Downgrading an existing story's source**:
1. Re-tag with `⚠️ Suggested by SC team, decision required` and state in one line what was suggested.
2. Reference an existing open Q if one exists; add one if not.
3. Don't delete the story — capability is probably still wanted under different terms.

## Keeping pages in sync

The catalogue lives across 2–3 Notion pages: Open Questions (always), Simplified (always), Verbose (Phase 2 only). **A story edit touches every page the change affects, in the same session.** Stale cross-references erode the entire catalogue.

### Edit-propagation matrix

| Change | Verbose (Phase 2) | Simplified | Open Questions |
|---|---|---|---|
| New story added | ✓ full entry | ✓ one-line entry, same ID | ✓ add new Qs referenced |
| Story re-titled / "so that" reframed | ✓ | ✓ (line must match new "so that") | — |
| Open Q resolved | ✓ remove "Depends on open Q", update story body | ✓ remove ❓ marker | ✓ move to "Resolved" |
| New open Q surfaced | ✓ add "Depends on open Q: QX.Y" | ✓ add `❓[QX.Y](link)` | ✓ add Q with candidate, source |
| Story deleted | ✓ remove (or mark superseded) | ✓ remove | ✓ resolve orphaned Qs |
| Story renumbered | NEVER | NEVER | — |
| Theme regrouped | ✓ | ✓ identical regrouping | — |

### Mandatory verification after every edit

- Every `❓Q*.*` in Simplified resolves to a real Q on Open Questions (no phantom references).
- Every Q on Open Questions is referenced by ≥1 story OR explicitly tagged `[META]` (see below).
- Every ID in Simplified appears in Verbose and vice versa (Phase 2).
- Every `Depends on open Q: QX.Y` in Verbose matches a `❓QX.Y` in Simplified (Phase 2).
- Every `(see IX)` cross-reference resolves to a real story.
- Open Questions counts footer reflects current state.

How to verify practically: fetch both pages, extract `Q*.*` markers from Simplified, extract real Q-ids from Open Questions, diff both directions. Same for `(see *)` against story IDs.

**Phantom Qs are the quickest path to "nobody trusts this doc anymore". Treat verification as ship-blocking.**

### Meta / cross-cutting Qs (excluded from orphan check)

Some Qs legitimately don't map to a single story:
- Catalogue-level deliverables ("produce an admin-capability matrix").
- Spec-level confirmations ("confirm V1 has zero oracle dependencies").
- Out-of-contract scope (audit budget, legal/compliance, KYB-routing ownership).
- Refinements of other Qs.

Tag these `[META]` in the title:
```
**Q4.6 [META] — Admin-capability matrix**
```

Sync check ignores `[META]`-tagged Qs. **When in doubt, link to a story** — `[META]` is a last resort.

### Notion editing mechanics

For block-anchor links, parallel-session drift, timeout-is-deceptive pattern, batched edits — see `references/notion-mcp.md`. Loading that doc is mandatory before any non-trivial Notion edit.

### Anti-pattern: "I'll fix the other page next"

Don't. Half-synced edits accumulate; eventually nothing is trusted. If you can't update all affected pages in one session, don't ship the change.

## Open-question linkage

Open questions live on their own dedicated page, never inline in stories. Stories reference Qs by ID only.

**Open Questions page structure**:
- **Top-level sections** (priority axis): `# BLOCKS SC design` / `# Nice-to-resolve` / `# Cosmetic` / `# V2 / Deferred` / `# Resolved`.
- **Lane sub-sections** within BLOCKS (audience axis): `## ⚠️ Product decisions needed` / `## [SC-DESIGN] technical questions` / `## [META] / cross-cutting`. Within each lane, group by theme.
- **Each Q**: `**QX.Y — Title — ⚠️ PRODUCT DECISION NEEDED**` / `**QX.Y — Title — [SC-DESIGN]**` / `**QX.Y [META] — Title**` + prose description + optional `*Candidate*: ...` + `*Source*: ...`.
- **Counts footer**: tally per top-level section. Update on every add/resolve.
- **Q-ID numbering**: stable per theme (Q1.x = fees, Q2.x = rewards). Don't renumber.

### Mandatory lane tagging — every Q must signal its audience

**Hard rule**: every open question must carry exactly one lane tag in its title — `⚠️ PRODUCT DECISION NEEDED` (Lane 2), `[SC-DESIGN]` (Lane 3), or `[META]` (cross-cutting / out-of-contract). Untagged Qs are sync failures.

Lane assignment — **strict criterion**:

- **⚠️ PRODUCT DECISION NEEDED** — the *requirement itself* is not yet fixed. Product needs to clarify what behavior they want. Includes: capability scope (V1 vs V2), policy choices (cooldowns, caps, thresholds), trade-offs that affect user-visible behavior, partner-driven decisions.
- **[SC-DESIGN]** — the *requirement is clear* and there are multiple valid implementations of the same behavior. SC team picks during contract design. **Test: "if you accept the requirement, is the user-visible outcome the same regardless of which option SC picks?" If yes → [SC-DESIGN]. If no → ⚠️ PRODUCT.**
- **[META]** — cross-cutting deliverable, spec confirmation, or out-of-contract scope.

**Common mis-tagging**: anything that affects what users see, what integrators can configure, or what's in V1 scope is **product**, even if it looks technical. Examples that LOOK like SC-design but are actually product:
- "Per-user vs pooled fee accounting" — different user-visible behaviors → ⚠️ PRODUCT
- "Max concurrent reward streams = N=?" — policy ceiling → ⚠️ PRODUCT
- "Whitelist mode: Merkle / mapping / both" — capability decision → ⚠️ PRODUCT
- "preview() net-of-fee vs gross" — downstream integration contract → ⚠️ PRODUCT

Genuine [SC-DESIGN] examples: rounding direction in convertToAssets, which functions get `nonReentrant`, CREATE2 vs CREATE for clone deployment, event schema field naming, reentrancy guard scope — all cases where the user-visible outcome is identical regardless of choice.

**For Qs with both aspects**: default to ⚠️ PRODUCT (the SC implementation follows once product locks the requirement). Use both tags only when the two aspects are genuinely independent.

**Why this matters**: without consistent lane tagging, the Open Questions page reads as one undifferentiated list. The operator can't quickly see "what does product need to answer this week" vs "what does SC team handle during design". Tag drift turns the catalogue into a wishlist.

**Linking from stories**:
- Verbose: `**Depends on open Q**: Q4.9 (one-line description).`
- Simplified: `❓[Q4.9](url)` — hyperlinked to the Open Questions page URL (block-level anchors typically not available; see `references/notion-mcp.md`).

**Lifecycle**:
- New Q while drafting a story → add to Open Questions in the same edit; link from the story.
- Q resolved → move to "Resolved" with rationale (Rx-numbered); strip story markers; update counts.
- Q's candidate shifts → edit Q in place; story bodies usually don't need touching.

**Anti-pattern: inline Q text in a story** — `Depends on open Q: should this be set globally?` (no Q-id, untrackable). Promote to a real Q with an ID; link by ID.

## Numbering & insertion discipline

- IDs are sticky once assigned. Treat like database primary keys.
- Inserting in the middle: append at end of theme group with next free number. Don't renumber.
- Splitting one story: keep original ID for the most-canonical result; new stories get fresh appended IDs.
- Deletion: prefer `(superseded by AX)` over removing — preserves the ID and audit trail. Only delete when a feature drops pre-implementation.
- Flag your numbering choice inline ("Placed at end of theme group, no renumbering").

## Question maintenance (audit / refine phase)

When the catalogue is past initial extraction and you're refining or auditing it, four patterns recur often enough to need a shared vocabulary: dispositions for questions that shift state (merge / reframe / elevate-to-story / remove / resolve), reframing a question whose threat surface changed because of an upstream decision, layered-concern decomposition for cross-cutting topics, and recognizing questions that should be removed rather than answered. See `references/question-maintenance.md` for the full patterns + worked examples. Read it before doing a refinement pass on an existing catalogue.

**The one rule to remember without opening the reference**: never silently delete a question. Every removal must show up in the coverage-check footer (`Q1.7 elevated to user story I26`, `Q6.2 removed as structurally answered by A5`, etc.). A year later, someone will ask why Q3.3 is missing — the footer must answer them in one line.

## Anti-patterns

- **Category-label titles instead of question titles.** `Fee mechanism` → `How should the performance fee crystallize?`. Apply to both stories ("Pause" → "Pause the wrapper in a partner-side incident") and open Qs.
- **Unlabeled options in prose.** Any body with 2+ alternatives must label them (a)/(b)/(c) and have the recommendation reference the letter. See "Readability format → Labeling multiple options".
- **Pros/Cons block with only one bullet on each side.** The trade-off isn't real — drop the block and just recommend.
- **"Non-user stories" describing what isn't built.** Stories phrased as "feature X is intentionally absent" / "interface Y is not implemented" are scope-documentation, not user stories. Capture out-of-scope items in `# V2 / Deferred` section of Open Questions. Litmus test: if the acceptance hint is "no selector exists for X" with nothing actively built, delete it.
- **Source-laundering.** Tagging notes-derived assumptions as `PRD`. If you can't cite a section number, it's not `PRD`.
- **Vague-umbrella titles without sub-points.** "Upgrade the factory" — list the concrete actions A2.1, A2.2, …
- **"Immutable" / "fixed" claims without enumerated exceptions.** If a contract is "immutable post-deploy", enumerate what *can* change (pause state, integrator params within bounds) and what *cannot* (bytecode, underlying, role topology).
- **Implementation in the story body.** `_burn(amount)` is a design detail, not a capability.
- **Mixing personas in one story.** "Admin and integrator can both pause" → split.
- **Burying ambiguity in prose.** "Probably this is done at harvest time" → make it an open Q with an ID.
- **Acceptance hints that re-state the story.** Delete and write a real hint.
- **Treating the catalogue as static.** When a design review answers an open Q, edit affected stories the same day.

## Workflow — drafting fresh from a PRD

1. Read PRD end-to-end first. Don't draft as you read.
2. Extract every "the system shall" / "users can" / "the admin must" into a flat list.
3. Cluster by persona, then by theme. 6 themes per persona typical, 12 is too many.
4. Number within each persona in lifecycle order (deploy → configure → operate → emergency).
5. For each item, draft Story + acceptance hints + Source. Citations non-negotiable on a first pass.
6. Pass over: what's missing? Standard categories PRDs forget — key rotation, observability, emergency response, edge cases. Add as `Source: Inferred`.
7. Comparable-product sweep: what do Morpho / Yearn / Compound / Aave / Synthetix do? Add as `*(research-derived)*`.
8. Open-questions extraction: every ambiguity, every "decide later" → a Q.

## Workflow — adding stories to an existing catalogue

1. Re-fetch the canonical pages (Simplified + Open Questions). Never draft from memory.
2. Read open questions in the same pass — many "new" stories are already-flagged ambiguities.
3. Identify persona + theme; find the right H3 section.
4. Pick next free ID in that persona.
5. Draft per the per-story format.
6. Cross-reference related stories.
7. New open Q → add to Open Questions in the same edit.
8. Update counts footer.
9. Verify sync (phantom + orphan + cross-ref + counts).

## Final review pass — the lightweight default

When the catalogue feels "done" and you want to verify before SC design lock, run the **three-lane filter**. Default review, 30–60 min solo.

### Three lanes

Every finding from any review is routed into exactly one of three lanes:

| Lane | Source of finding | Where it goes | Who decides |
|---|---|---|---|
| **1. PRD coverage** | Capability **in PRD** missing/mis-stated in catalogue | Add/fix story directly | You (catalogue operator) |
| **2. Product decision** | Capability **NOT in PRD** — proposed by research / reviewer / design | Open Q tagged `⚠️ PRODUCT DECISION NEEDED` | Product team |
| **3. SC technical** | Implementation detail PRD doesn't speak to (ERC-4626 edge cases, accounting, MEV, gas, reentrancy) | Plain open Q | SC team / auditor (during design) |

If a finding doesn't fit any lane → noise → drop it.

### Procedure

1. **Walk PRD section by section.** For each requirement: covered by a story? If not → Lane 1 (add). If wrong → Lane 1 (fix). 15–30 min.
2. **Walk catalogue story by story.** Does PRD authorize this? If unclear → Lane 2 (open `⚠️ PRODUCT DECISION NEEDED` with candidate, default V2 unless flagged). 15 min.
3. **Scan open Qs.** Each candidate good enough for SC team to design against, or needs product? Move `⚠️` tags as needed. 10 min.
4. **Consistency check** (phantom / orphan / cross-ref / counts). 5 min.

**Output**: a tight `⚠️ PRODUCT DECISION NEEDED` list for product + a clean catalogue ready for SC design.

### What you do NOT do

- ❌ Generate "proposed changes" lists with 30+ items. Not in a lane → drop.
- ❌ Propose PRD edits.
- ❌ Add stories for capabilities the PRD doesn't authorize. Open a `⚠️` Q instead.
- ❌ Catalogue-craft polish during review. That's editing, do it separately.

### Persistent artifact — PRD coverage matrix

Lane-1 walkthrough naturally produces a PRD-section → story-IDs mapping. Maintain as a sibling page (or Verbose section in Phase 2). Update every review. On the next review, the matrix is your starting point, not blank slate.

### Deep review — escalation only

The multi-agent persona review (5 personas with named characters) is escalation-only, NOT default. Trigger only when going into high-stakes audit, the product has truly bimodal users, or an incident exposed a class of finding lightweight review missed. Expect ~50 findings of which ~25 are noise. See `references/deep-review-persona-pass.md` for the full procedure.

### Anti-patterns

- **Treating "30 findings" as success.** Output of a good review is a short list of decisions, not a long list of things to think about.
- **Adding stories before product green-lights.** Catalogue claims authority it doesn't have.
- **Letting the catalogue become a wishlist.** Stories are commitments to build; wishlist items are open Qs until product approves.
- **Running deep review as default.** Optimizes for finding things, not for finding decisions.

## Reference example

The LI.FI Programmable Vault Wrapper user stories at https://www.notion.so/35df0ff14ac78180b8f1ca564c424c1a — canonical worked example: 3 personas, ~65 stories, dual-path authority model with sub-points (A2), research-derived stories flagged, every dependency linked to an open Q.

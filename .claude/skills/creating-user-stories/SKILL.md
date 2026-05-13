---
name: creating-user-stories
description: Use when drafting, maintaining, refining, or auditing a structured user-stories catalogue from a product spec + design-review notes + open-questions list. Outputs persona-grouped stories with explicit linkage to unresolved open questions, in a readable format suited for product, engineering, and audit review alike. Trigger on "write user stories for", "draft stories from this spec", "expand the user stories", "add a story for X", "audit the catalogue", "clean up the open questions", "refine the stories", or any request to produce or maintain a stories catalogue. Use this skill whenever the user is working on a structured stories catalogue or its companion open-questions page, even if they don't say "user story" explicitly. Skip for casual feature lists or one-off ticket descriptions.
---

# Creating User Stories

## When to use

A **structured, auditable user-stories catalogue** — the kind that feeds a design doc, audit scope, or estimate. Not for one-off tickets or casual feature lists.

**Inputs**: product spec / PRD, design-review or meeting notes, open-questions list (or create one in parallel), optional comparable-product research.

**Output**: two pages — a **Stories** page and a companion **Open Questions** page. One readable format per page.

## Core principles

1. **One story = one discrete capability.** No "AND" in titles or action clauses. See "One-action-one-benefit grammar".
2. **Surface unknowns, don't hide them.** A story shape that depends on an unresolved decision → mark with `❓Q-id`. Never invent an answer.
3. **Research-derived stories** are flagged `*(research-derived)*` in the title to distinguish from spec-derived stories.
4. **Stable IDs.** Once assigned, never renumber. Append new stories at the end of their theme group with the next free number.
5. **Cross-doc alignment is non-negotiable.** Every `❓Q-id` must resolve to a real Q. Phantom Q references erode trust. See "Keeping pages in sync".
6. **Spec is owned by product.** The catalogue surfaces tensions as questions; it never proposes spec edits. See "Spec ownership rule".
7. **Human-readable framing wins.** Every story and every open Q must read like a sentence a smart colleague would write to another smart colleague — not a wall of jargon. See "Readability format" below.

## Readability format

The catalogue is read by product managers, engineers, auditors, and ops. None of them tolerate dense jargon. Apply these rules to **every story body and every open-question body**:

### Phrasing

- **Titles are the actual question or capability**, not category labels. ✓ *"What's the maximum allowed concurrent stream count?"* — ✗ *"Stream count cap"*.
- **One plain sentence per idea.** If a sentence has 3 clauses joined by commas/semicolons, split it.
- **Lead with the decision, not the mechanism.** Reader-facing body asks "what should the system do?", not "how does the implementation work?". Implementation belongs in the technical lane, not the story body.
- **Drop filler.** Phrases like "It should be noted that…", "In order to…", "Different trade-offs exist…" — strip. Say the thing.

### Labeling multiple options

**Hard rule**: whenever a body presents 2+ discrete options (alternative behaviors, alternative mechanisms, alternative scopes), label them **(a)**, **(b)**, **(c)**, … and have the *Recommendation* explicitly reference the chosen letter.

```
*What*: **(a)** open to all, **(b)** invite-only, or **(c)** approval-gated.
*Recommendation*: **(a)** — lowest friction for first-time users.
```

Reasons:
1. The reader can scan options in one pass.
2. The recommendation is unambiguous — no "the second one" or "invite-only"-style indirection that forces re-reading.
3. Sub-questions can reference the letter: "If (b) is chosen, who issues invites?"

When sub-options nest under one parent, use roman numerals to disambiguate:
```
*Sub-questions if (b)*: (i) who issues invites? (ii) how do invitees redeem? (iii) expiry policy?
```

**When NOT to label**: single-recommendation bodies, TBD entries with no enumerated choices, one-liners. If you find yourself writing "(a)" alone without a sibling, drop the label.

### Pros / Cons

Add a *Pros* / *Cons* block **only when the trade-off is real and a product owner needs to weigh it**. If you find yourself listing only one Pro or one Con, the trade-off isn't real — delete the section and just recommend.

## Structure

### Persona grouping (H2)

Group stories by who wants the capability. Typical persona shapes for an internal-platform team:

- `## As an [Org] admin, I want to...` — IDs start with `A`
- `## As an integrator, I want to...` — IDs start with `I`
- `## As an end user, I want to...` — IDs start with `U`

Adapt to your domain (operator / viewer / partner / regulator / curator) but keep persona separation. One story does not span multiple personas — if you find one that does, split it.

### Theme sub-grouping (H3)

Within each persona, group stories by theme. Themes vary by product. Common shapes: lifecycle (deploy → configure → operate → decommission), permissioning, pricing or economics, safety and pause, observability, integrations, compliance. 6 themes per persona is typical; more than 10 usually means you should split a theme.

### Per-story format

```
- **A1.** [verb-lowercase] [object], so that [why]. ❓[Q4.5](link), [Q9.1](link)
```

The persona phrase ("As a ...") is in the H2 heading, not repeated per story. One sentence each. No acceptance hints, no implementation detail — those belong in the design doc that consumes this catalogue, not in the story.

Variants:
- **Sub-points** (A2.1, A2.2 …) when a story is an umbrella that fans out to several concrete sub-actions. List each sub-action.
- **Cross-references**: `(see A16)`, `(mirrors I18)` for adjacent-lifecycle stories — see below.

## One-action-one-benefit grammar

A user story has exactly two semantic slots: `[verb] [object], so that [benefit]`. Strict rule: **one action, one benefit, no compound verbs in the action clause.**

### Fix patterns

| Smell | Fix |
|---|---|
| `update price AND emit event, so that…` | Drop the mechanism: `update price within bounds, so that I can react to market.` Events are implementation. |
| `pause writes AND reads, so that…` | Either split into two stories OR one composite: `pause the instance, so that…` |
| `do X so that things keep working` | Sharpen the benefit: name the persona-specific stake, not generic "system works". |

### Acceptable "and"

`run end-of-day close, so that the day's transactions are crystallized AND the next-day balance is initialized.` — "and" connects two *outcomes* of one action. Fine. Compare to `crystallize AND initialize` in the action clause = two buttons, both must be pressed.

### Quality check per sentence

1. One verb in the action clause? (`trigger X` / `configure Y` = single verb-object, OK.)
2. The "so that" names a persona-specific stake, not generic "system works"?
3. If "and" appears, is it joining outcomes (downstream of one action), not parallel actions?
4. Reader at risk of conflating with an adjacent-lifecycle story? Add a `(see IX)`.

## Cross-referencing adjacent-lifecycle stories

Two stories on the same concept at different lifecycle stages can be confused by a reader. Always cross-link with `(see IX)`.

Examples of pairings worth cross-linking:
- Configure-time vs runtime (set up an admin role vs use the role).
- Inject vs schedule vs distribute vs cancel (for any flow with multiple temporal states).
- Different pause variants — emergency, scheduled, partial.

**Bidirectional** — if A→B is worth linking, B→A usually is. Verify on every edit.

## Spec ownership rule

The product spec is owned by the product team, NOT by the catalogue author. The catalogue's job:

1. **Surface tensions** when stories drift from the spec or need to add capabilities the spec doesn't authorize.
2. **Flag tensions as questions for product**, tagged `⚠️ PRODUCT DECISION NEEDED`.
3. **Never edit the spec.** That's a product-team action.

Anti-pattern: writing "Recommend spec-amend §X.Y to authorize …". The catalogue's role is to *surface the question*, not to *prescribe the answer*.

### Phrasing template for product-decision Qs

Follow the readability format (title is the actual question; options labeled; recommendation references a letter). Two flavors depending on whether there's a real trade-off:

**Standard (most Qs)**:
```
**QX.Y — [The actual decision question]**
*What*: [one-sentence context]. **(a)** ..., **(b)** ..., **(c)** ...
*Recommendation*: **(b)** — [rationale in plain English].
```

**With trade-off (only when a product owner must weigh options)**:
```
**QX.Y — [The actual decision question]**
*What*: [one-sentence context describing the capability and why it's debatable].
*Pros*:
- [specific upside]
- [specific upside]
*Cons*:
- [specific downside]
- [specific downside]
*Recommendation*: **[defer / accept / specific option]** — [rationale].
```

Note: the lane tag (⚠️ PRODUCT DECISION NEEDED / [TECH] / [META]) sits on the **section header**, not in every question title — see "Open-question linkage".

**Anti-patterns**:
- Title as a category label (`Pricing mechanism`) instead of a question (`How should pricing be tiered?`).
- Options listed in prose without (a)/(b) labels.
- Recommendation that doesn't reference one of the labeled options.
- Pros/Cons with only one bullet on each side — the trade-off isn't real, just recommend.

## Surfacing implicit properties

Some user-visible properties fall out "for free" from the architecture and have no explicit story. Readers ask about them first because they're invisible.

**Litmus test**: when reviewing the catalogue, ask "what questions would a first-time reader have here that the catalogue doesn't answer because the answer is architectural?" If the answer is yes, write the implicit-property story and cross-reference where the property comes from.

## The "naming a story" red flag

If a story title contains a noun that could mean many things (`"manage the allowlist"`, `"handle errors"`), it's too vague. Either:
- (a) Split into multiple concrete stories, or
- (b) Keep the umbrella but enumerate sub-actions A2.1, A2.2, …

Rule of thumb: if a reader can ask "which actions exactly?", you must list them. Most common failure mode in spec-derived stories — the spec says "the system is configurable" and the story inherits the vagueness.

## Keeping pages in sync

The catalogue lives across 2 pages: a Stories page and an Open Questions page. **A story edit touches every page the change affects, in the same session.** Stale cross-references erode the entire catalogue.

### Edit-propagation matrix

| Change | Stories page | Open Questions page |
|---|---|---|
| New story added | ✓ one-line entry | ✓ add any new Qs the story references |
| Story re-titled / "so that" reframed | ✓ | — |
| Open Q resolved | ✓ remove ❓ marker | ✓ move to "Resolved" section |
| New open Q surfaced | ✓ add `❓[QX.Y](link)` | ✓ add Q with candidate |
| Story deleted | ✓ remove | ✓ resolve orphaned Qs |
| Story renumbered | NEVER | — |

### Mandatory verification after every edit

- Every `❓Q*.*` in Stories resolves to a real Q on Open Questions (no phantom references).
- Every Q on Open Questions is referenced by ≥1 story OR explicitly tagged `[META]` (see below).
- Every `(see IX)` cross-reference resolves to a real story.
- Open Questions counts footer reflects current state.

How to verify practically: fetch both pages, extract `Q*.*` markers from Stories, extract real Q-ids from Open Questions, diff both directions. Same for `(see *)` against story IDs.

**Phantom Qs are the quickest path to "nobody trusts this doc anymore". Treat verification as ship-blocking.**

### Meta / cross-cutting Qs (excluded from orphan check)

Some Qs legitimately don't map to a single story:
- Catalogue-level deliverables ("produce an access-control matrix").
- Spec-level confirmations ("confirm V1 has no external dependencies").
- Out-of-scope concerns (legal, compliance, ownership questions).
- Refinements of other Qs.

Tag these `[META]` in the title:
```
**Q4.6 [META] — Access-control matrix**
```

Sync check ignores `[META]`-tagged Qs. **When in doubt, link to a story** — `[META]` is a last resort.

### Notion editing mechanics

For block-anchor links, parallel-session drift, batched edits — see `references/notion-mcp.md`. Loading that doc is mandatory before any non-trivial Notion edit.

### Anti-pattern: "I'll fix the other page next"

Don't. Half-synced edits accumulate; eventually nothing is trusted. If you can't update all affected pages in one session, don't ship the change.

## Open-question linkage

Open questions live on their own dedicated page, never inline in stories. Stories reference Qs by ID only.

**Open Questions page structure**:
- **Top-level sections** (priority axis): `# BLOCKS [design-name]` / `# Nice-to-resolve` / `# Cosmetic` / `# Deferred` / `# Resolved`.
- **Lane sub-sections** within BLOCKS (audience axis): `## ⚠️ Product decisions needed` / `## [TECH] technical questions` / `## [META] cross-cutting`. Within each lane, group by theme.
- **Each Q**: `**QX.Y — Title**` + prose description + optional `*Recommendation*: ...`. The lane tag sits on the section header — no need to repeat the tag in every title.
- **Counts footer**: tally per top-level section. Update on every add/resolve. Also acts as the audit trail when questions move dispositions (merged, removed, elevated to a story) — see `references/question-maintenance.md`.
- **Q-ID numbering**: stable per theme (Q1.x = one theme, Q2.x = another). Don't renumber.

### Mandatory lane tagging — every Q must signal its audience

**Hard rule**: every open question must sit in exactly one lane — `⚠️ PRODUCT DECISION NEEDED`, `[TECH]`, or `[META]`. Untagged Qs (or questions in the wrong lane) are sync failures.

Lane assignment — **strict criterion**:

- **⚠️ PRODUCT DECISION NEEDED** — the *requirement itself* is not yet fixed. Product needs to clarify what behavior they want. Includes: capability scope (V1 vs V2), policy choices, trade-offs that affect user-visible behavior, partner-driven decisions.
- **[TECH]** — the *requirement is clear* and there are multiple valid implementations of the same behavior. Tech team picks during implementation. **Test: "if you accept the requirement, is the user-visible outcome the same regardless of which option tech picks?" If yes → [TECH]. If no → ⚠️ PRODUCT.**
- **[META]** — cross-cutting deliverable, spec confirmation, or out-of-scope.

**Common mis-tagging**: anything that affects what users see, what integrators can configure, or what's in V1 scope is **product**, even if it looks technical. The product/tech distinction is about *what's already decided*, not *who will work on it*.

**For Qs with both aspects**: default to ⚠️ PRODUCT (the technical implementation follows once product locks the requirement). Use both tags only when the two aspects are genuinely independent.

**Why this matters**: without consistent lane tagging, the Open Questions page reads as one undifferentiated list. The operator can't quickly see "what does product need to answer this week" vs "what does tech team handle during implementation". Tag drift turns the catalogue into a wishlist.

**Linking from stories**: `❓[Q4.9](url)` — hyperlinked to the Open Questions page URL.

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

When the catalogue is past initial extraction and you're refining or auditing it, four patterns recur often enough to need a shared vocabulary: dispositions for questions that shift state (merge / reframe / elevate-to-story / remove / resolve), reframing a question whose context changed because of an upstream decision, layered-concern decomposition for cross-cutting topics, and recognizing questions that should be removed rather than answered. See `references/question-maintenance.md` for the full patterns + worked examples. Read it before doing a refinement pass on an existing catalogue.

**The one rule to remember without opening the reference**: never silently delete a question. Every removal must show up in the counts footer (`Q1.7 elevated to user story I26`, `Q6.2 removed as structurally answered by A5`, etc.). A year later, someone will ask why Q3.3 is missing — the footer must answer them in one line.

## Anti-patterns

- **Category-label titles instead of question titles.** `Pricing` → `How should tier boundaries be calculated?`. Apply to both stories and open Qs.
- **Unlabeled options in prose.** Any body with 2+ alternatives must label them (a)/(b)/(c) and have the recommendation reference the letter.
- **Pros/Cons block with only one bullet on each side.** The trade-off isn't real — drop the block and just recommend.
- **"Non-user stories" describing what isn't built.** Stories phrased as "feature X is intentionally absent" / "interface Y is not implemented" are scope-documentation, not user stories. Capture out-of-scope items in the Deferred section of Open Questions.
- **Vague-umbrella titles without sub-points.** "Upgrade the system" — list the concrete actions A2.1, A2.2, …
- **Implementation detail in the story body.** Specific function names, code patterns, exact event payloads — these belong in the design doc that consumes the catalogue, not the user story.
- **Mixing personas in one story.** "Admin and integrator can both pause" → split.
- **Burying ambiguity in prose.** "Probably this is done at flush time" → make it an open Q with an ID.
- **Treating the catalogue as static.** When a design review answers an open Q, edit affected stories the same day.

## Workflow — drafting fresh from a spec

1. Read the spec end-to-end first. Don't draft as you read.
2. Extract every "the system shall" / "users can" / "the admin must" into a flat list.
3. Cluster by persona, then by theme. 6 themes per persona typical, 12 is too many.
4. Number within each persona in lifecycle order (deploy → configure → operate → emergency).
5. For each item, draft the one-line story.
6. Pass over: what's missing? Standard categories specs forget — key rotation, observability, emergency response, edge cases. Add them.
7. Comparable-product sweep — load the **Research phase** below if the catalogue feeds high-stakes downstream work. Research-derived items end up tagged `*(research-derived)*` with a `*Source*: [link]` pointer.
8. Open-questions extraction: every ambiguity, every "decide later" → a Q.

## Research phase — when the catalogue feeds high-stakes downstream work

**Trigger** — the catalogue feeds an audit, an estimate, a third-party review, a budget decision, or any artifact someone signs off on. Skip for internal-only catalogues used for a single team's quick alignment.

Without this phase, a catalogue typically underproduces by ~20–30% on coverage of failure modes, edge cases, prior-art-anti-patterns, and "things to invert from what the obvious blueprint did." That gap doesn't show up at draft time — it shows up at audit / review when reviewers ask "what about X?" and X was visible in any comparable product the operator didn't read.

The phase runs **in parallel with — or just before — initial drafting**, not after. After-drafting research re-opens the catalogue; parallel research feeds it cleanly.

### The comparable set — roles, not products

Pick 3–5 prior-art systems. A useful default mix, expressed as **roles** (the domain instantiates the role):

- **Explicit blueprint** — the system the spec/PRD itself references as "we want one of these."
- **Marquee-customer reality** — what the named target customer / user actually uses today (often diverges from what the spec assumes about them).
- **Dominant competitor / win-back target** — the system you're displacing in deals.
- **Field-wide comparison** — table across 5–10 adjacent systems, shallow per cell but wide; surfaces convergent patterns.
- **Adjacent-but-distinct** — a system that solves a related but different problem; clarifies what your scope is *not*.

You don't always need all 5. Below ~3 you lose triangulation; above ~5 the operator can't hold the synthesis in head.

### Recipe

1. **Dispatch one subagent per comparable, in parallel.** Each writes a single-topic deep-dive to `raw/NN-<comparable>.md`. Standard prompt template + multi-domain worked examples in `references/research-phase.md` — load before dispatching.
2. **Synthesize into `research-analysis.md`** — one section per comparable, each closing with a **COPY / IMPROVE / AVOID** three-line summary.
3. **Cross-cutting findings section** at the end of `research-analysis.md` — patterns visible across multiple comparables (convergent architecture, recurring anti-patterns, shared blind spots).
4. **During drafting**, every research-derived story / open Q carries `*(research-derived)*` + `*Source*: [link into raw/ or research-analysis.md]`. Provenance is non-negotiable — see verification step.

### The COPY / IMPROVE / AVOID frame

The single load-bearing output discipline. For each comparable, the subagent closes with three explicit lines:

- **COPY** — what this system gets right that we should mirror.
- **IMPROVE** — what this system gets approximately right; we should ship a stronger version.
- **AVOID** — what this system gets wrong (known anti-pattern, public incident, community-flagged); we should invert it.

Research without this frame becomes a wiki — interesting but undecidable. With the frame, every research-derived story or open Q has an answer to "why does this exist in the catalogue?"

### Output contract

`raw/` directory exists with 3–5 single-topic files, each citing primary sources. `research-analysis.md` exists, references every `raw/` file, has the COPY / IMPROVE / AVOID frame per comparable, has a cross-cutting findings section. Stories and open Qs derived from it are tagged + sourced.

### Anti-patterns

- **One subagent doing all comparables.** Loses parallel-independence value; consolidates bias.
- **Agents reading each other's outputs mid-flight.** Convergent answers look like consensus but are correlation.
- **Secondary sources only.** Blog-post-about-a-product instead of the product's docs / source / governance / post-mortem.
- **Skipping COPY/IMPROVE/AVOID.** Research becomes reference material, not catalogue input.
- **Research after drafting is locked.** Re-opens the catalogue and erodes the audit trail. Run in parallel or up front.

## Workflow — adding stories to an existing catalogue

1. Re-fetch the canonical pages (Stories + Open Questions). Never draft from memory.
2. Read open questions in the same pass — many "new" stories are already-flagged ambiguities.
3. Identify persona + theme; find the right H3 section.
4. Pick next free ID in that persona.
5. Draft per the per-story format.
6. Cross-reference related stories.
7. New open Q → add to Open Questions in the same edit.
8. Update counts footer.
9. Verify sync (phantom + orphan + cross-ref + counts).

## Final review pass — the lightweight default

When the catalogue feels "done" and you want to verify before locking it for downstream design work, run the **three-lane filter**. Default review, 30–60 min solo.

### Three lanes

Every finding from any review is routed into exactly one of three lanes:

| Lane | Source of finding | Where it goes | Who decides |
|---|---|---|---|
| **1. Spec coverage** | Capability **in spec** missing/mis-stated in catalogue | Add/fix story directly | You (catalogue operator) |
| **2. Product decision** | Capability **NOT in spec** — proposed by research / reviewer / design | Open Q tagged `⚠️ PRODUCT DECISION NEEDED` | Product team |
| **3. Tech implementation** | Implementation detail spec doesn't speak to | Plain open Q tagged `[TECH]` | Tech team / reviewer (during design) |

If a finding doesn't fit any lane → noise → drop it.

### Procedure

1. **Walk spec section by section.** For each requirement: covered by a story? If not → Lane 1 (add). If wrong → Lane 1 (fix). 15–30 min.
2. **Walk catalogue story by story.** Does spec authorize this? If unclear → Lane 2 (open `⚠️ PRODUCT DECISION NEEDED` with candidate, default V2 unless flagged). 15 min.
3. **Scan open Qs.** Each candidate good enough for tech team to design against, or needs product? Move `⚠️` tags as needed. 10 min.
4. **Consistency check** (phantom / orphan / cross-ref / counts). 5 min.

**Output**: a tight `⚠️ PRODUCT DECISION NEEDED` list for product + a clean catalogue ready for design.

### What you do NOT do

- ❌ Generate "proposed changes" lists with 30+ items. Not in a lane → drop.
- ❌ Propose spec edits.
- ❌ Add stories for capabilities the spec doesn't authorize. Open a `⚠️` Q instead.
- ❌ Catalogue-craft polish during review. That's editing, do it separately.

### Persistent artifact — spec coverage matrix

Lane-1 walkthrough naturally produces a spec-section → story-IDs mapping. Maintain as a sibling page. Update every review. On the next review, the matrix is your starting point, not a blank slate.

### Deep review — escalation only

A multi-agent persona review (with named senior reviewer personas) is escalation-only, NOT default. Trigger only when going into high-stakes review, the product has truly bimodal users, or an incident exposed a class of finding lightweight review missed. Expect ~50 findings of which ~25 are noise. See `references/deep-review-persona-pass.md` for the procedure — note that the reference's specific persona set is calibrated for smart-contract review and should be re-cast for your domain if different.

### Anti-patterns

- **Treating "30 findings" as success.** Output of a good review is a short list of decisions, not a long list of things to think about.
- **Adding stories before product green-lights.** Catalogue claims authority it doesn't have.
- **Letting the catalogue become a wishlist.** Stories are commitments to build; wishlist items are open Qs until product approves.
- **Running deep review as default.** Optimizes for finding things, not for finding decisions.

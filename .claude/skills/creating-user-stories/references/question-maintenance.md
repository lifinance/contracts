# Question maintenance — lifecycle, reframing, layering, removal

Reference for the question-maintenance patterns that surface when the catalogue is being refined or audited (not when it's first drafted). Read this when the catalogue is past initial extraction and you're cleaning up dispositions, redrafting questions whose threat surface changed, or pruning questions that don't really exist.

## Question lifecycle dispositions

Open questions are not just "open" or "resolved." During catalogue maintenance, a question can shift to one of several dispositions. Each has a specific marker and a coverage-check entry so the trail is recoverable.

| Disposition | Marker on the surviving entry | Coverage-check footnote |
|---|---|---|
| **Kept as-is** | (none) | listed in counts |
| **Merged into another Q** | `*(absorbs former QX.Y)*` on the surviving Q's title | `QA.B *(absorbs QX.Y)*` in counts |
| **Reframed downstream of another Q** | `*(reframed — downstream of QX.Y)*` on the title; body adds *Threat-model dependency on QX.Y* or *Interactions* paragraph | listed normally; no count change |
| **Elevated to a user story** | Q removed from catalogue; corresponding story (new or updated) carries the assumption | footer notes: "QX.Y elevated to user story (IZ + updated IW)" |
| **Removed as structurally answered** | Q removed entirely | footer notes: "QX.Y removed as structurally answered by AZ / QW" |
| **Resolved** | Move to `# Resolved` section with an `RX` number; preserve the question text + the resolution | footer counts the Resolved section |

**Hard rule**: never silently delete a question. Every removal must show up in the coverage-check footer. The catalogue's auditability depends on this — a year later, someone will ask "why isn't there a Q3.3?" and the footer answers them in one line.

**Coverage-check footer is the audit trail.** It's not just a sanity counter. Keep historical change notes inline (`— Q1.7 and Q3.3 elevated to user stories (I26 + updated I7); Q6.2 removed as structurally answered by A5; Q11.3 merged into Q9.3`). When dispositions accumulate, prune the oldest ones only after the change has been internalized by the team (i.e. after the relevant SC design milestone).

**Resolved section must exist if you reference it.** If any open Q body says "Q4.10 already resolved..." or "R10 locks...", the `# Resolved` section must contain a real entry with that ID. Phantom resolved-refs are the same trust failure as phantom open-Q refs. If a decision is locked via a user story (e.g. U20 "withdrawals always available"), reference the *story*, not a non-existent Resolved Q.

## Reframing a question when upstream decisions change its threat surface

When an earlier decision (often in the same review session) changes what a downstream question is actually asking, don't silently rewrite the question — reframe it explicitly:

1. Add `*(reframed — downstream of QX.Y)*` to the title.
2. Keep the question itself answerable (don't collapse to "moot"). Reframe the options to match the new threat surface.
3. Add a *Threat-model dependency on QX.Y* paragraph that explains the dependency: what changed, what residual concerns remain, and what happens if the upstream decision reverts.
4. The recommendation should note whether the question is still load-bearing or has become defense-in-depth.

Worked example shape: when an upstream architectural decision is locked, a downstream protection question often goes from "load-bearing" to "defense-in-depth" because the canonical attack vector is mostly closed by the upstream decision. The downstream question stays open (residual concerns matter), but the body now opens with the dependency and the recommendation explicitly calls out that the question is "optional, not load-bearing." If the upstream decision later reverts, the downstream becomes load-bearing again — the explicit reframing makes that recoverable.

The reason to reframe explicitly rather than rewrite silently: future readers need to understand why the question's framing changed. A silent rewrite looks like the question was always shaped that way; an explicit reframing shows the decision trail and lets the reader undo it if the upstream decision reverts.

## Layered-concern decomposition

For cross-cutting topics (compliance, observability, monitoring, rate limiting, access control), questions often confuse readers because the topic spans multiple layers of the stack. The fix:

1. **In the *What* section, enumerate the layers** and who enforces at each. A small table helps. Generic example for a typical service stack:
   - Identity provider (Auth0 / Okta / etc.) — enforces who you are.
   - API gateway / WAF — enforces rate limits, geo restrictions, request shape.
   - Application — enforces business rules and feature gates.
   - Data layer — enforces final access control.
2. **Scope the question to one layer.** The decision is *which layer we play at*, not whether the concern is handled at all.
3. **Cross-reference adjacent layers** so the reader understands the question's scope without re-deriving it.

Without layered decomposition, a single question collapses into something like "should we do compliance?" — un-answerable. With the layers explicit, the question becomes "at which layer do we play?" — a concrete decision.

This pattern shows up most often for: compliance / blacklisting / sanctions, observability and event emission, rate limiting, access control distributed across layers. When you spot a topic spanning layers, decompose it before answering.

## Common reasons to remove rather than answer a question

A question may look open but actually be already-determined by an earlier decision. Signs:

- The "options" all collapse to the same outcome under existing constraints.
- The answer is implied by an `A`-story already in the catalogue (e.g. A5 already mandates an on-chain allowlist — a Q asking "where does the allowlist live?" is moot).
- The decision is *operational* (which DEXes to support, which tools to use) rather than *architectural* — operational decisions belong in runbooks, not the SC design catalogue.
- The question is asking about a mechanism, not a requirement, AND a clear requirement already exists — that's `[SC-DESIGN]`, not `⚠️ PRODUCT`.

When you spot one of these, remove the question and add a footer note explaining the disposition. Don't leave a TBD-recommendation question lingering just because it was originally drafted.

The opposite trap is also worth naming: don't *answer* a question that looks decided by writing a fake recommendation. If you find yourself writing "*Recommendation*: TBD" three times in a row, or if every option in your draft collapses to the same answer, the question itself is the problem — surface it, don't paper over it.

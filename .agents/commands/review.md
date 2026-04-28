---
name: review
description: Address all open PR review threads — categorize, triage, fix/reply, verify, push, mark resolved
usage: /review <PR-NUMBER>
---

# PR Review — Address Comments (`/review`)

> **Usage**: `/review 312`
>
> Reads every open review thread on the PR, classifies each one, implements fixes
> in priority order, replies to each thread, and pushes — without touching anything
> beyond what reviewers explicitly asked for.

---

## Inputs

`$ARGUMENTS` — a GitHub PR number (e.g. `312`).

Determine the repo from `git remote get-url origin`. Abort with a clear message if the
remote is not a GitHub URL.

---

## Phase 0 — INVENTORY (before touching any file)

> *"Don't assume. Don't hide confusion. Surface tradeoffs."* — Karpathy

1. **Fetch PR metadata**:
   ```bash
   gh pr view $PR --json title,headRefName,baseRefName,body,author
   ```

2. **Resolve the Linear ticket** — extract the ticket ID from the PR (in priority order):
   - Branch name (e.g. `feat/eng-423-add-foo` → `ENG-423`)
   - PR title (e.g. `ENG-423: add FooFacet`)
   - PR body (look for `Closes ENG-423`, `Fixes ENG-423`, or a bare `ENG-423` reference)

   If a ticket ID is found:
   - `get_issue($ID)` — title, description, acceptance criteria, status
   - `list_comments($ID)` — prior discussion, design decisions, clarifications

   Use this context throughout: when a reviewer questions *why* something was done,
   the ticket AC and discussion is the authoritative source for intent.
   If no ticket ID is found, proceed without — note it in the Phase 1 triage output.

3. **Fetch all review threads** (open + resolved, to understand context):
   ```bash
   gh api repos/{owner}/{repo}/pulls/$PR/comments --paginate
   gh api repos/{owner}/{repo}/pulls/$PR/reviews --paginate
   ```

3. **Build the thread inventory** — for every comment thread, record:
   | Field | Value |
   |---|---|
   | Thread ID | `r<id>` |
   | File + line | `src/Facets/Foo.sol:42` |
   | Reviewer | `@handle` |
   | Body | (first 2 lines) |
   | Status | open / resolved |
   | Type | BLOCKER / CHANGE / QUESTION / NITPICK |

4. **Type classification rules**:
   - **BLOCKER** — breaks correctness, safety, or security; "this will X"; "bug:"; "wrong"; direct security concern; must be fixed before merge
   - **CHANGE** — explicit edit request: naming, structure, docs, style; typically clear what to do
   - **QUESTION** — asking why; asking for explanation; "why does this..."; "what is..."
   - **NITPICK** — prefixed with "nit:", "minor:", "optional:", "feel free to ignore"; polish only

   When type is unclear, prefer the higher-severity classification.

5. **Scan for tx-hash escalation triggers** — before classifying threads, check if any
   thread references a specific transaction hash or says "this tx reverts / fails on-chain".
   If found: run `/analyze-tx <network> <hash>` first. The trace output is the source of
   truth for understanding the root cause; use it to inform your fix and your reply.

6. **Print the inventory** to the user before proceeding to Phase 1.

---

## Phase 1 — TRIAGE

1. **Surface threads requiring a decision** — any BLOCKER where the right fix is
   ambiguous. Ask **one focused question** per ambiguous BLOCKER. Wait for answer
   before implementing that thread.

2. **Fix order**: `BLOCKER` → `CHANGE` → `QUESTION replies` → `NITPICK`

3. **Skip conditions** (document in final summary, do not silently omit):
   - Thread already resolved (race condition)
   - Reviewer explicitly said "optional, up to you" — note as skipped, explain why
   - Thread conflicts with another — flag to user before picking a resolution

---

## Phase 2 — IMPLEMENT

> *"Touch only what you must. Clean up only your own mess."* — Karpathy

**For BLOCKER / CHANGE threads**:
- Edit exactly the lines the reviewer references — no more, no less
- Do not refactor adjacent code that works correctly
- Do not rename things beyond the reviewer's explicit ask
- Match existing style; do not introduce new patterns unless asked

**For QUESTION threads**:
- Draft a reply that explains the reasoning (reference file/line if helpful)
- Only make a code change if the explanation would be "this is wrong" — in which case reclassify as BLOCKER/CHANGE

**For NITPICK threads**:
- Fix silently (no reply needed unless the fix is non-obvious)
- If the nitpick is controversial or conflicts with a rule, note in the PR summary comment and leave it

**No new abstractions** — do not extract helpers, introduce shared utilities, or add
indirection unless at least two independent reviewer comments independently request it.

**Rule-anchored responses** — when a reviewer raises a domain concern, ground your reply
in the relevant rule rather than improvising:

| Reviewer raises | Use this anchor | What to say / check |
|---|---|---|
| Gas / efficiency concern | `106-gas` `[CONV:GAS]` | Prefer existing Solady/Solmate patterns; surface tradeoffs, don't micro-optimize silently |
| Security / access control | `105-security` | Check `Validatable`, `LibAsset`, `LibSwap`, `LibAllowList` for prior art; state governance impact |
| Architecture / Diamond concern | `002-architecture` `[CONV:ARCH-DIAMOND]` | Storage slots, selector layout, facet separation |
| Wrong event location | `002-architecture` `[CONV:EVENTS]` | `LiFiTransferStarted` only in `_startBridge`; `LiFiTransferCompleted` only in Executor |
| Whitelist file in wrong PR | `502-whitelist-branching` | PR must target `main`; split if targeting feature branch |
| Failing on-chain tx | `600-transaction-analysis` | Run `/analyze-tx <network> <hash>` first; reply with trace findings |

---

## Phase 3 — VERIFY

Run all checks relevant to files you changed. **State exact output; do not claim clean without running.**

| Changed files | Command |
|---|---|
| `src/**/*.sol` | `forge test` (full suite or targeted) |
| `script/**/*.ts`, `tasks/**/*.ts` | `bun test:ts` + `bunx tsc-files --noEmit <files>` |
| Any `.sol` | `bunx solhint <file>` |
| Any `.ts`/`.js` | `bunx eslint <file>` |
| Formatting | `bun format:fix` |

If any check fails, fix it before Phase 4. Do not push a red build.

---

## Phase 4 — PUBLISH

> *"Define success criteria. Loop until verified."* — Karpathy

1. **Commit**:
   ```bash
   git commit -m "address PR #$PR review comments"
   ```
   If fixes naturally split into logical units, use multiple commits with descriptive messages.

2. **Push**:
   ```bash
   git push
   ```

3. **Reply to each thread** — for every thread you acted on:
   ```bash
   # Reply to a comment thread
   gh api repos/{owner}/{repo}/pulls/$PR/comments/$COMMENT_ID/replies \
     -f body="<reply text>"
   ```
   Reply format by type:
   - **BLOCKER/CHANGE fixed**: "Fixed in <commit sha short>. <one-line description of what changed>."
   - **QUESTION answered**: "<explanation>. Happy to clarify further if needed."
   - **NITPICK fixed**: "Done." (brief is fine for nitpicks)
   - **NITPICK skipped**: "Left as-is — <one-sentence reason>."

4. **Post a PR summary comment**:
   ```bash
   gh pr comment $PR --body "..."
   ```
   ```markdown
   ## Review comments addressed

   | Thread | File | Type | Action |
   |---|---|---|---|
   | r12345 | `src/Foo.sol:42` | CHANGE | Fixed — renamed to `fooBar` |
   | r12346 | `src/Bar.sol:10` | QUESTION | Replied — explained reentrancy guard intent |
   | r12347 | `src/Baz.sol:5` | NITPICK | Fixed silently |

   **Tests**: forge test — 42 passed, 0 failed
   **Lint**: solhint — no issues
   ```

---

## LI.FI Conventions (apply to any files you touch)

- SPDX-License-Identifier: LGPL-3.0-only on all `.sol` files
- NatSpec on all public/external functions you modify
- `viem` only in TypeScript (no `ethers`)
- No Diamond storage layout changes without explicit ticket
- No governance bypass (Safe/timelock)

---

## Abort Conditions

- A BLOCKER's required fix is unclear and reviewer is unresponsive → post a comment
  asking for clarification; do not guess; do not push
- A fix requires changing the Diamond storage layout → stop, flag to user
- Tests fail after 2 fix attempts → stop, report exact failure to user

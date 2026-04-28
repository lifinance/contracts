---
name: ticket
description: End-to-end Linear ticket implementation — read, plan, implement, verify, update Linear status, post summary
usage: /ticket <TICKET-ID>
---

# Ticket Implementation (`/ticket`)

> **Usage**: `/ticket ENG-423`
>
> Runs the full loop: understand the ticket → plan → implement → verify → update Linear → post summary.

---

## Inputs

`$ARGUMENTS` — a Linear ticket ID (e.g. `ENG-423`, `INFRA-12`).

Parse the workspace prefix and number; abort with a clear message if the format does not
match `[A-Z]+-\d+`.

---

## Phase 0 — THINK (before touching any file)

> *"Don't assume. Don't hide confusion. Surface tradeoffs."* — Karpathy

1. **Fetch the ticket in full**:
   - `get_issue($ID)` — title, description, status, priority, assignee, labels, parent
   - `list_comments($ID)` — all prior discussion, reviewer notes, clarifications
   - If linked/blocking issues exist: fetch each with `get_issue`
   - If a PR is linked: note the branch name

2. **Extract and echo back**:
   - Acceptance criteria (numbered list; flag if none are explicit)
   - Ambiguities or missing constraints
   - Files/modules likely in scope based on the description
   - Any "definition of done" hints in comments

3. **State assumptions explicitly** — list every inference you made.
   If any AC item is ambiguous, post a Linear comment asking one focused question
   and **stop**. Do not implement until clarified.

4. **Load applicable rules** — identify every rule that activates for the files you expect
   to touch. Use this table:

   | Files you'll edit | Active rules | Key enforcements |
   |---|---|---|
   | `src/Facets/**/*.sol` | `100`, `101`, `102`, `105`, `106` | `[CONV:LICENSE]` `[CONV:NATSPEC]` `[CONV:EVENTS]` `[CONV:ARCH-DIAMOND]`, selector layout, event locations |
   | `src/Interfaces/**/*.sol` | `100`, `103` | interface-only patterns, no logic |
   | `src/Periphery/Receiver*.sol` | `100`, `104` | receiver-specific patterns |
   | `src/**/*.sol` (other) | `100`, `101`, `105`, `106` | security, gas, NatSpec |
   | `script/**/*.s.sol` | `100`, `107` | deploy script patterns |
   | `script/**/*.ts`, `tasks/**/*.ts` | `200`, `105` | viem-only, no ethers, type safety |
   | `script/deploy/safe/**/*.ts` | `200`, `201` | Safe/timelock decode conventions |
   | `script/deploy/tron/**/*.ts` | `200`, `202` | TronWeb, address encoding |
   | `test/**/*.t.sol` | `100`, `400`, `401` | test structure, naming, coverage expectations |
   | `**/*.test.ts` | `402` | Bun test structure |
   | `**/*.sh` | `300` | bash safety, exit codes |
   | `config/whitelist.json` | `502` | **PR must target `main`** — see Critical Guards below |
   | `.github/workflows/**` | `500` | immutable action SHAs, no tag refs |

   Always-active rules (apply regardless): `000`, `001`, `002`, `003`, `099`.

---

## Phase 1 — PLAN

> *"Minimum code that solves the problem. Nothing speculative."* — Karpathy

1. **Define success criteria** — one bullet per AC item, phrased as a verifiable
   test: "done when `forge test --match-test testFoo` passes" or
   "done when the TS script exits 0 with expected output".

2. **Identify files to change** — list paths. If you cannot identify them without
   exploring, explore first; do not start editing until you know the full diff scope.

3. **Choose the approach** — if two valid paths exist, name both with tradeoffs;
   pick the smallest diff unless conventions or security justify the larger refactor.
   No speculative abstractions; no helpers used by only one caller.

4. **Output a compact plan**:
   ```
   Branch:   feat/ENG-423-<slug>
   Files:    src/Facets/FooFacet.sol, script/deploy/facets/DeployFoo.s.sol
   Tests:    forge test --match-contract FooFacetTest
   Lint:     bunx solhint src/Facets/FooFacet.sol
   ```

---

## Phase 2 — IMPLEMENT

> *"Touch only what you must. Clean up only your own mess."* — Karpathy

1. **Branch** — always create a feature branch; never commit directly to `main`/`develop`:
   ```bash
   git checkout -b feat/<TICKET-ID-lowercase>-<short-slug>
   # e.g. feat/eng-423-add-foo-facet
   ```

2. **Edit only the files identified in Phase 1.**
   - Do not improve adjacent code that works correctly.
   - Do not rename identifiers beyond what the ticket asks.
   - Match existing style, spacing, and comment density exactly.
   - If you spot unrelated dead code, mention it in the summary — do not delete it.

3. **Follow all active rules** — conventions from `.agents/rules/` apply to every file
   you touch (`[CONV:LICENSE]`, `[CONV:NATSPEC]`, `[CONV:NAMING]`, etc.).

4. **Critical Guards** — check these before committing:

   - **Whitelist files** (`config/whitelist.json`, `config/composerWhitelist.json`): the PR
     **must target `main`**, not a feature branch. If your current branch targets a feature
     branch, split the whitelist change into a separate PR targeting `main`. (rule `502`)

   - **Event emission** (`[CONV:EVENTS]`): `LiFiTransferStarted` only inside `_startBridge`
     after all validations/calls; `LiFiTransferCompleted` only in `Executor.sol`;
     `LiFiTransferRecovered` only in `Receiver*.sol`. Never emit these elsewhere.

   - **Storage / selector layout**: any change that could shift storage slots or selectors
     must be called out explicitly in the Linear comment before merging. Do not silently
     add storage variables to existing facets. (rule `002`)

   - **Gas** (`106`): call out any non-obvious gas tradeoffs in the summary so the user
     can decide. Do not apply micro-optimizations silently.

   - **Security** (`105`): use `Validatable`, `LibAsset`, `LibSwap`, `LibAllowList` for
     validation — no ad-hoc checks. Any admin-touching change must state governance impact.

5. **Commit** when all files for a logical unit are done:
   ```
   <TICKET-ID>: <imperative short description>

   # e.g.
   ENG-423: add FooFacet with bar() swap path
   ```
   One commit per logical unit; do not mix unrelated changes.

---

## Phase 3 — VERIFY

> *"Define success criteria. Loop until verified."* — Karpathy

Run all checks relevant to the files you touched. **Do not claim done without running them.**

| Changed files | Command |
|---|---|
| `src/**/*.sol` | `forge test` (full suite or `--match-contract <TestContract>`) |
| `script/**/*.s.sol` | `forge build` + dry-run if possible |
| `script/**/*.ts`, `tasks/**/*.ts` | `bun test:ts` + `bunx tsc-files --noEmit <files>` |
| Any `.sol` | `bunx solhint <file>` — fix all reported issues |
| Any `.ts`/`.js` | `bunx eslint <file>` — fix all reported issues |
| Formatting | `bun format:fix` |

State the exact output (pass/fail/count) for each command run.
If a check cannot be run (e.g. no test suite for a new contract yet), say so explicitly
and create a follow-up note in the Linear comment.

---

## Skill Escalation

Some ticket types are better served by a dedicated skill. Escalate (invoke the skill) before
or instead of implementing manually:

| Situation | Escalate to |
|---|---|
| `forge test` fails with a specific on-chain revert (has a tx hash) | `/analyze-tx <network> <hash>` — trace-first root cause analysis before fixing |
| Tests produce a suspicious revert you can't explain from code alone | `/analyze-tx` with a forked tx |
| Ticket asks to add a new chain/network | `/add-network` — handles networks.json, foundry.toml, permit2Proxy, gaszip, bridge configs |
| Ticket asks to remove/deprecate a network | `/deprecate-network` — removes from all config files safely |
| A previous audit finding is relevant to this ticket | Check `audit/auditLog.json`; use `/review-bounty-report` if a new bounty report is involved |

After the escalated skill completes, return to this workflow (Phase 3 verify → Phase 4 publish).

---

## Phase 4 — PUBLISH

Only proceed here after Phase 3 is clean.

1. **If open questions remain** — post a Linear comment with the questions,
   set ticket to `In Progress` (or leave as-is), and stop. Wait for clarification.

2. **Update ticket status**:
   ```
   save_issue(id: $ID, stateId: <In Review state ID>)
   ```
   To find the right state ID, call `get_issue_status` or `list_issue_statuses` for the team.

3. **Post summary comment** via `save_comment($ID, body: ...)`:
   ```markdown
   ## Implementation summary

   **Branch**: `feat/eng-423-add-foo-facet`
   **Commit**: `ENG-423: add FooFacet with bar() swap path`

   ### What was done
   - <bullet per AC item, marked done ✓>

   ### Tests
   - `forge test`: 42 passed, 0 failed
   - `bunx solhint src/Facets/FooFacet.sol`: no issues

   ### Open questions / follow-ups
   - <any unresolved edges, or "none">
   ```

4. **Do not push** the branch unless the user explicitly asks to open a PR or push.
   Leave branch local until requested.

---

## LI.FI Conventions Checklist

Before posting the summary, verify:

- [ ] SPDX-License-Identifier: LGPL-3.0-only on every new `.sol` file
- [ ] NatSpec (`@notice`, `@param`, `@return`) on every public/external function
- [ ] Events emitted in correct locations (see `[CONV:EVENTS]` in rules)
- [ ] No interface or storage layout changes unless the ticket explicitly requires them
- [ ] Diamond selector conflicts checked if a new facet was added
- [ ] Safe + timelock governance flows not bypassed
- [ ] TypeScript uses `viem` (not `ethers`)
- [ ] Addresses normalized for multi-chain scripts (Tron detection if applicable)

---

## Abort Conditions

Stop and notify the user (do not implement) if:

- AC is absent or contradictory and clarification returns nothing useful
- The ticket requires changes to the Diamond storage layout without a migration plan
- The ticket would bypass governance (Safe/timelock) — flag explicitly
- Tests fail and you cannot determine the root cause within 2 fix attempts

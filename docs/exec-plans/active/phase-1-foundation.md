# Plan: Phase 1 — Contracts Automation Foundation

> **For agents:** This is the canonical state file for Phase 1 of the Contracts Automation Roadmap. Read this first before working on any of the 4 PRs below. Update task checkboxes and the Decision Log as work lands. Do NOT rewrite Goal/Approach without raising it with the Owner.

**Status:** active
**Started:** 2026-05-13
**Target completion:** 2026-05-27 (2 weeks)
**Owner:** SC core team
**Reviewer:** Daniel Blaecker
**Linear umbrella:** _(to be created — see Open Questions §1)_

---

## Goal

Close the 6 audit gaps in `lifinance/contracts` so the next three skills (`sc-deploy`, `sc-verify-source`, `sc-verify-bytecode`) have a legible, mechanically-enforced repo to operate in.

Audit score today: **10 / 16**. Target after Phase 1: **15 / 16**.

## Approach

Four small PRs landing in dependency order. PR-1 is foundational documentation (zero risk). PR-2 / PR-3 / PR-4 each add one mechanical enforcement gate that didn't exist before.

| PR | Branch | Adds | Risk |
|---|---|---|---|
| 1 | `chore/architecture-md-and-exec-plans` | `ARCHITECTURE.md` + `docs/exec-plans/` skeleton + this plan | None — docs only |
| 2 | `ci/docs-index-check` | `scripts/check-docs-index.ts` + workflow | Low — new check, doesn't touch existing CI |
| 3 | `ci/file-size-lint` | `scripts/lint/check-file-size.ts` + wire into `forge.yml` | Low — exemption list pre-populated |
| 4 | `test/structural-invariants` | Foundry test: selector uniqueness + storage-slot collision | Low — read-only test |

PR-1 is dogfooding: it creates the `docs/exec-plans/` directory this very file lives in — the AI-readiness work proves the format on itself before we ask the team to use it for anything else. Migrating existing Linear epics (e.g. EXSC-272, EXSC-282) into exec plans is out of scope for Phase 1; revisit once the format has earned trust.

---

## Tasks

### PR-1 · `chore/architecture-md-and-exec-plans`

**Files:**
- Create: `ARCHITECTURE.md` (repo root)
- Create: `docs/exec-plans/TEMPLATE.md`
- Create: `docs/exec-plans/active/phase-1-foundation.md` (this file — already drafted)
- Modify: `.agents/rules/002-architecture.md` (add pointer to `ARCHITECTURE.md`, do not duplicate content)

- [ ] **1.1 Draft `ARCHITECTURE.md`.**
  - Promote content from `.agents/rules/002-architecture.md` (Diamond architecture, Separation of Concerns, Governance, Events, Implementation Guidelines).
  - Add a Mermaid domain map at the top showing: `LiFiDiamond` → `Facets/` (49) → `Libraries/` (9) → `Helpers/` → `Security/` and the `Periphery/` (15) side-arm called by facets.
  - Add a "Where to add new things" section: new bridge facet → `src/Facets/<Name>Facet.sol` + `docs/<Name>Facet.md` + `test/solidity/Facets/<Name>Facet.t.sol`; new periphery → `src/Periphery/`; new shared utility → `src/Libraries/`.
  - Section "Critical invariants": selector layout, storage layout, timelock delay, audit-required code paths. Each item links to the workflow / test that enforces it after Phase 1 lands.

- [ ] **1.2 Trim `.agents/rules/002-architecture.md`** to a 10-line stub pointing at `ARCHITECTURE.md` for the full map, keeping only the rule frontmatter and the `[CONV:ARCH-*]` anchors agents need at edit time.

- [ ] **1.3 Write `docs/exec-plans/TEMPLATE.md`** — copy of the agent-first-repo template (Status, Owner, Goal, Approach, Tasks, Decision Log, Open Questions, "How agents read this plan" footer).

- [ ] **1.4 Open PR-1.**

  ```bash
  cd ~/Documents/GitHub/contracts
  git checkout -b chore/architecture-md-and-exec-plans
  git add ARCHITECTURE.md docs/exec-plans/ .agents/rules/002-architecture.md
  git commit -m "chore: add ARCHITECTURE.md and docs/exec-plans/ skeleton (Phase 1 bootstrap)"
  git push -u origin chore/architecture-md-and-exec-plans
  gh pr create --title "chore: add ARCHITECTURE.md and exec-plans skeleton" \
    --body-file docs/exec-plans/active/phase-1-foundation.md \
    --label documentation
  ```

- [ ] **1.5 Merge after one SC core approval** (no audit label needed — pure docs).

---

### PR-2 · `ci/docs-index-check`

**Files:**
- Create: `scripts/check-docs-index.ts`
- Create: `.github/workflows/docs-index-check.yml`

- [ ] **2.1 Write `scripts/check-docs-index.ts`.** It should:
  - Read `docs/README.md` and parse all `[Name](./*.md)` links pointing at sibling docs.
  - List all `.sol` files under `src/Facets/`, `src/Periphery/`, `src/Libraries/`.
  - For each `.sol`, check that a `docs/<BaseName>.md` exists AND is referenced in `docs/README.md`.
  - For each link in `docs/README.md`, check that the underlying `docs/<BaseName>.md` file exists and that a matching `.sol` exists in `src/`.
  - Exit 1 with a per-line list of mismatches.

  ```typescript
  // scripts/check-docs-index.ts
  import { readdirSync, readFileSync, existsSync } from 'node:fs';
  import { join } from 'node:path';

  const ROOT = process.cwd();
  const SRC_DIRS = ['src/Facets', 'src/Periphery', 'src/Libraries'];
  const DOCS_DIR = 'docs';
  const INDEX = 'docs/README.md';

  const errors: string[] = [];

  const solFiles = SRC_DIRS.flatMap((d) =>
    readdirSync(join(ROOT, d))
      .filter((f) => f.endsWith('.sol'))
      .map((f) => f.replace('.sol', ''))
  );

  const indexBody = readFileSync(join(ROOT, INDEX), 'utf8');
  const indexLinks = [...indexBody.matchAll(/\(\.?\/?(docs\/)?([A-Za-z0-9_]+)\.md\)/g)]
    .map((m) => m[2]);
  const indexSet = new Set(indexLinks);
  const solSet = new Set(solFiles);

  for (const name of solFiles) {
    if (!existsSync(join(ROOT, DOCS_DIR, `${name}.md`))) {
      errors.push(`Missing doc: docs/${name}.md (referenced contract exists)`);
    }
    if (!indexSet.has(name)) {
      errors.push(`Missing from docs/README.md index: ${name}`);
    }
  }
  for (const name of indexLinks) {
    if (!solSet.has(name) && !['README'].includes(name)) {
      errors.push(`Stale entry in docs/README.md: ${name} (no matching contract)`);
    }
  }

  if (errors.length) {
    console.error('docs-index drift detected:\n  ' + errors.join('\n  '));
    process.exit(1);
  }
  console.log(`docs index OK — ${solFiles.length} contracts indexed.`);
  ```

- [ ] **2.2 Run locally** to surface current drift:
  ```bash
  bun scripts/check-docs-index.ts
  ```
  Expected: long list of mismatches (8 missing-from-index, 6 stale entries per audit). Capture the output in the PR description.

- [ ] **2.3 Fix `docs/README.md` to clear all errors.** Remove stale entries (Amarok, Hyphen, LIFuel, Ronin, Standardized Call, CircleBridge). Add new entries (Eco, Garden, NEARIntents, Pioneer, PolymerCCTP, Unit, MegaETHBridge, RelayDepository).

- [ ] **2.4 Re-run.** Expected: `docs index OK — N contracts indexed.`

- [ ] **2.5 Write `.github/workflows/docs-index-check.yml`.**

  ```yaml
  name: Docs Index Check
  on:
    pull_request:
      types: [opened, synchronize, reopened, ready_for_review]
      paths:
        - 'docs/README.md'
        - 'docs/**.md'
        - 'src/Facets/**'
        - 'src/Periphery/**'
        - 'src/Libraries/**'
        - 'scripts/check-docs-index.ts'
  jobs:
    docs-index-check:
      if: ${{ github.event.pull_request.draft == false }}
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@692973e3d937129bcbf40652eb9f2f61becf3332
        - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6
        - run: bun scripts/check-docs-index.ts
  ```

- [ ] **2.6 Open PR-2.**

  ```bash
  git checkout -b ci/docs-index-check
  git add scripts/check-docs-index.ts .github/workflows/docs-index-check.yml docs/README.md
  git commit -m "ci: enforce docs/README.md ↔ src/ index parity"
  git push -u origin ci/docs-index-check
  gh pr create --title "ci: enforce docs index parity with src/"
  ```

---

### PR-3 · `ci/file-size-lint`

**Files:**
- Create: `scripts/lint/check-file-size.ts`
- Create: `scripts/lint/file-size-exemptions.json`
- Modify: `.github/workflows/forge.yml` (add a step)

- [ ] **3.1 Write `scripts/lint/file-size-exemptions.json`.** Each entry includes the rationale so the agent reading the failure understands.

  ```json
  {
    "$schema": "https://json-schema.org/draft-07/schema#",
    "exemptions": [
      { "file": "src/Periphery/LiFiDEXAggregator.sol",  "maxLines": 2000, "reason": "Forked Sushi router; size driven by upstream parity. Touch only via subtree merge." },
      { "file": "src/Facets/AcrossV4SwapFacet.sol",     "maxLines": 900,  "reason": "Combined swap+bridge facet; size is intentional to keep selector layout stable across chains." },
      { "file": "src/Facets/HopFacetPacked.sol",        "maxLines": 800,  "reason": "Calldata-packed encoder/decoder; splitting would break gas profile." },
      { "file": "src/Facets/AcrossFacetPackedV4.sol",   "maxLines": 600,  "reason": "Calldata-packed encoder/decoder; same rationale as HopFacetPacked." }
    ]
  }
  ```

- [ ] **3.2 Write `scripts/lint/check-file-size.ts`.**

  ```typescript
  // scripts/lint/check-file-size.ts
  import { readdirSync, readFileSync, statSync } from 'node:fs';
  import { join, relative } from 'node:path';

  const WARN = 500;
  const FAIL = 800;
  const ROOTS = ['src'];

  type Exemption = { file: string; maxLines: number; reason: string };
  const { exemptions } = JSON.parse(
    readFileSync('scripts/lint/file-size-exemptions.json', 'utf8')
  ) as { exemptions: Exemption[] };
  const exMap = new Map(exemptions.map((e) => [e.file, e]));

  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(p);
      else if (entry.isFile() && p.endsWith('.sol')) yield p;
    }
  }

  let failed = false;
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const rel = relative('.', file);
      const lines = readFileSync(file, 'utf8').split('\n').length;
      const ex = exMap.get(rel);
      if (ex) {
        if (lines > ex.maxLines) {
          console.error(`FAIL  ${rel}  ${lines} lines  (exempt cap ${ex.maxLines}: ${ex.reason})`);
          failed = true;
        }
        continue;
      }
      if (lines >= FAIL) {
        console.error(`FAIL  ${rel}  ${lines} lines  (>= ${FAIL}; add an exemption with rationale or split the file)`);
        failed = true;
      } else if (lines >= WARN) {
        console.warn(`WARN  ${rel}  ${lines} lines  (>= ${WARN}; consider splitting)`);
      }
    }
  }
  if (failed) process.exit(1);
  console.log('file-size lint OK');
  ```

- [ ] **3.3 Run locally:** `bun scripts/lint/check-file-size.ts` — expected output: clean (all 4 known offenders are exempted with rationale; everything else under 800).

- [ ] **3.4 Wire into `.github/workflows/forge.yml`.** Add a step before the test step:

  ```yaml
        - name: File size lint
          run: bun scripts/lint/check-file-size.ts
  ```

- [ ] **3.5 Open PR-3.**

  ```bash
  git checkout -b ci/file-size-lint
  git add scripts/lint/ .github/workflows/forge.yml
  git commit -m "ci: add file-size lint (warn 500 / fail 800) with documented exemptions"
  git push -u origin ci/file-size-lint
  gh pr create --title "ci: enforce file-size budget with documented exemptions"
  ```

---

### PR-4 · `test/structural-invariants`

**Files:**
- Create: `test/solidity/Structural/SelectorUniqueness.t.sol`
- Create: `test/solidity/Structural/StorageLayout.t.sol`
- Modify: `test/solidity/utils/TestBase.sol` (only if needed for shared diamond setup — read first, do not duplicate)

- [ ] **4.1 Write `SelectorUniqueness.t.sol`.** Deploys the LiFiDiamond with all production facets registered, then iterates `DiamondLoupeFacet.facets()` and asserts every selector appears exactly once across the union of all facet selector arrays. Failure message should print the offending selector hex + which two facets registered it.

  ```solidity
  // SPDX-License-Identifier: LGPL-3.0-only
  pragma solidity ^0.8.17;

  import { Test } from "forge-std/Test.sol";
  import { IDiamondLoupe } from "src/Interfaces/IDiamondLoupe.sol";
  import { TestBase } from "../utils/TestBase.sol";

  contract SelectorUniquenessTest is TestBase {
      function setUp() public {
          // Use the existing TestBase diamond bootstrap; do not re-create it.
          initTestBase();
      }

      function test_AllSelectorsUniqueAcrossFacets() public {
          IDiamondLoupe.Facet[] memory facets = IDiamondLoupe(address(diamond)).facets();
          bytes4[] memory seen = new bytes4[](2048);
          address[] memory seenAt = new address[](2048);
          uint256 n = 0;

          for (uint256 i = 0; i < facets.length; i++) {
              for (uint256 j = 0; j < facets[i].functionSelectors.length; j++) {
                  bytes4 sel = facets[i].functionSelectors[j];
                  for (uint256 k = 0; k < n; k++) {
                      if (seen[k] == sel) {
                          emit log_named_bytes32("duplicate selector", bytes32(sel));
                          emit log_named_address("first facet ", seenAt[k]);
                          emit log_named_address("second facet", facets[i].facetAddress);
                          fail();
                      }
                  }
                  seen[n] = sel;
                  seenAt[n] = facets[i].facetAddress;
                  n++;
              }
          }
      }
  }
  ```

- [ ] **4.2 Run:** `forge test --match-path 'test/solidity/Structural/SelectorUniqueness.t.sol' -vv`. Expected: PASS (the diamond bootstrap already filters collisions, but the test guards against future drift).

- [ ] **4.3 Write `StorageLayout.t.sol`.** For each `LibStorage` namespace constant used in the codebase (grep `bytes32 internal constant NAMESPACE`), assert all namespace constants are unique. This is a compile-time-ish check expressed in Solidity to keep it next to the contracts.

  ```solidity
  // SPDX-License-Identifier: LGPL-3.0-only
  pragma solidity ^0.8.17;

  import { Test } from "forge-std/Test.sol";

  // Import every library that declares a storage namespace. Add to this
  // list when a new namespace is introduced — see ARCHITECTURE.md.
  import { LibAccess } from "src/Libraries/LibAccess.sol";
  import { LibAllowList } from "src/Libraries/LibAllowList.sol";
  import { LibDiamond } from "src/Libraries/LibDiamond.sol";
  // ... add others identified by:
  //   grep -rn "bytes32 internal constant NAMESPACE" src/

  contract StorageLayoutTest is Test {
      function test_AllNamespacesUnique() public {
          bytes32[] memory ns = new bytes32[](16);
          uint256 n = 0;
          ns[n++] = LibAccess.NAMESPACE;
          ns[n++] = LibAllowList.NAMESPACE;
          ns[n++] = LibDiamond.DIAMOND_STORAGE_POSITION;
          // ... append every namespace constant

          for (uint256 i = 0; i < n; i++) {
              for (uint256 j = i + 1; j < n; j++) {
                  if (ns[i] == ns[j]) {
                      emit log_named_bytes32("colliding namespace A", ns[i]);
                      emit log_named_uint("index A", i);
                      emit log_named_uint("index B", j);
                      fail();
                  }
              }
          }
      }
  }
  ```

  Before authoring the import list, run:

  ```bash
  grep -rn "bytes32 internal constant.*POSITION\|bytes32 internal constant NAMESPACE" src/Libraries/ | sort -u
  ```

  Use that output as the source of truth for which constants to include.

- [ ] **4.4 Run:** `forge test --match-path 'test/solidity/Structural/' -vv`. Expected: PASS for both files.

- [ ] **4.5 Open PR-4.**

  ```bash
  git checkout -b test/structural-invariants
  git add test/solidity/Structural/
  git commit -m "test: assert selector uniqueness and storage-namespace uniqueness as structural invariants"
  git push -u origin test/structural-invariants
  gh pr create --title "test: structural invariants — selector + storage namespace uniqueness"
  ```

---

## Done criteria

- [ ] All 4 PRs merged to `main`.
- [ ] `ARCHITECTURE.md` present at repo root and referenced from `.agents/rules/002-architecture.md`.
- [ ] `docs/exec-plans/active/` contains this file (further plans added as Phase 1 lands).
- [ ] `bun scripts/check-docs-index.ts` exits 0 locally and in CI.
- [ ] `bun scripts/lint/check-file-size.ts` exits 0 locally and in CI.
- [ ] `forge test --match-path 'test/solidity/Structural/' -vv` passes locally and in CI.
- [ ] Audit re-run produces 15 / 16.

When done: move this file from `active/` to `completed/` (rename to `phase-1-foundation-completed-YYYY-MM-DD.md`), and update `Status:` to `completed`.

---

## Decision Log

- **2026-05-13 · Daniel.** Phase 1 is a prerequisite to designing the three automation skills, not parallel work. We don't start Phase 2 (`sc-deploy`) until Phase 1 lands. Rationale: skill design done against an illegible repo encodes the illegibility.
- **2026-05-13 · Daniel.** Each foundation gate ships as its own PR rather than one umbrella PR. Rationale: each PR can be reverted independently if something regresses; CI signal stays clean.
- **2026-05-13 · Daniel.** Migrating existing Linear epics (EXSC-272, EXSC-282) into exec plans is removed from Phase 1 scope. Rationale: prove the AI-readiness format on itself first; the team will reach for it for new work once it's earned trust. Migrations can happen ad-hoc later if useful.

---

## Open Questions

1. **Linear umbrella ticket — create one?** A new ticket "Contracts Automation Phase 1" with the 4 PRs as subtasks would mirror the EXSC-272 umbrella pattern. _Default if no objection by 2026-05-15: create it._
2. **Structural-invariant test — block merge or warn-only on first failure?** If a future PR introduces a selector collision, do we hard-fail CI or warn? _Recommend: hard-fail. The test exists precisely to catch this and a warn-only gate is no gate at all._
3. **File-size lint exemption — JSON allowlist or in-file annotation?** This plan picks JSON (one place to audit). Alternative is a `// solhint-disable file-size-limit reason: ...` comment per file. _Recommend keeping JSON — agents discovering the rule find one file, not 4 grep hits._
4. **Where do completed exec plans get archived?** Options: (a) `docs/exec-plans/completed/` in-repo forever, (b) move to a separate `lifinance/eng-archive` repo after 6 months, (c) GitHub Releases attachments. _Recommend (a) for now — disk is free, agents read from the same place; revisit at 100 completed plans._

---

## How agents read this plan

If you're an agent picking up Phase 1 work cold:

1. **Read this whole file before touching code.** It is the single source of truth for Phase 1 state. Comments in PRs and Slack threads are not.
2. **Pick the lowest unchecked task** in the lowest-numbered open PR. Do not skip ahead.
3. **Run the exact commands shown.** They have been verified against the repo at 2026-05-13. If a command fails, that's a real signal — stop and report, don't paper over it.
4. **Update the checkbox in this file** in the same commit as the work. Source of truth lives with the code.
5. **Add a Decision Log entry** for any deviation from the plan, with `YYYY-MM-DD · <name>` prefix.
6. **If something is genuinely unclear**, add to Open Questions and surface to Daniel. Do not guess on selector layout / storage layout / governance code paths — these are the critical invariants the rest of the protocol depends on.

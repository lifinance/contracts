# Deployment Address Consistency Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block any commit that introduces a contract-address mismatch between `config/whitelist.json`, `deployments/<network>.json`, and `deployments/<network>.diamond.json`.

**Architecture:** A single offline TypeScript script exposes a pure `findMismatches()` core (unit-tested with fixtures), an `affectedNetworks()` helper that derives the in-scope networks from staged paths, a `loadSources()` file reader (optionally filtered), and a CLI entrypoint. Default invocation scans all networks (manual/CI audit); `--staged` scopes to only the networks whose staged files changed and is what the husky pre-commit step calls. Both periphery and facet mismatches block. No RPC, no CI, no Claude gate.

**Note on execution:** Tasks 1 and 2 are already implemented (commits e6f8c00e, e80d1a84, 56ab004e, ae7ccb6a). Task 2's live run surfaced ~26 pre-existing mismatches on `main`, which drove the scoping decision now captured in the spec's "Scope" section and in Task 2.5 below. The repo-root resolution uses `fileURLToPath(import.meta.url)` (not `import.meta.dir`) for `bunx tsx` compatibility.

**Tech Stack:** TypeScript run via `bunx tsx`, `bun:test` for unit tests, `consola` for output, husky/bash pre-commit hook.

**Spec:** `docs/superpowers/specs/2026-06-11-deployment-address-consistency-gate-design.md`

---

## Task 1: Validator script (pure core + loader + CLI)

**Files:**

- Create: `script/tasks/checkDeploymentAddressConsistency.ts`
- Test: `script/tasks/checkDeploymentAddressConsistency.test.ts`

- [ ] **Step 1: Write the failing test**

Create `script/tasks/checkDeploymentAddressConsistency.test.ts`:

```typescript
import { describe, expect, it } from 'bun:test'

import {
  findMismatches,
  type NetworkSources,
} from './checkDeploymentAddressConsistency'

const base: NetworkSources = {
  network: 'testnet',
  whitelistPeriphery: {},
  deploymentFlat: {},
  diamondPeriphery: {},
  diamondFacets: {},
}

describe('findMismatches', () => {
  it('returns no mismatches when all sources agree (case-insensitive)', () => {
    const sources: NetworkSources[] = [
      {
        ...base,
        whitelistPeriphery: { OutputValidator: '0xAAA' },
        deploymentFlat: { OutputValidator: '0xaaa', DiamondCutFacet: '0xF00' },
        diamondPeriphery: { OutputValidator: '0xAaA' },
        diamondFacets: { DiamondCutFacet: '0xf00' },
      },
    ]
    expect(findMismatches(sources)).toEqual([])
  })

  it('flags a periphery address that disagrees with the deployment log', () => {
    const sources: NetworkSources[] = [
      {
        ...base,
        whitelistPeriphery: { OutputValidator: '0x293bef' },
        deploymentFlat: { OutputValidator: '0x1581ca9' },
        diamondPeriphery: { OutputValidator: '0x1581ca9' },
      },
    ]
    const result = findMismatches(sources)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      network: 'testnet',
      kind: 'periphery',
      contract: 'OutputValidator',
    })
    expect(result[0].addresses).toHaveLength(3)
  })

  it('flags a facet address that disagrees between the two deployment files', () => {
    const sources: NetworkSources[] = [
      {
        ...base,
        deploymentFlat: { DexManagerFacet: '0xnew' },
        diamondFacets: { DexManagerFacet: '0xold' },
      },
    ]
    const result = findMismatches(sources)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      kind: 'facet',
      contract: 'DexManagerFacet',
    })
  })

  it('ignores empty placeholders and contracts present in only one source', () => {
    const sources: NetworkSources[] = [
      {
        ...base,
        whitelistPeriphery: { Patcher: '0xabc' },
        deploymentFlat: { Patcher: '0xabc' },
        diamondPeriphery: { Patcher: '' }, // not deployed -> ignored
        diamondFacets: { LonelyFacet: '0x999' }, // only one source -> ignored
      },
    ]
    expect(findMismatches(sources)).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test script/tasks/checkDeploymentAddressConsistency.test.ts`
Expected: FAIL — cannot resolve module `./checkDeploymentAddressConsistency` (file does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `script/tasks/checkDeploymentAddressConsistency.ts`:

```typescript
import { existsSync, readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'

import { consola } from 'consola'

const REPO_ROOT = resolve(import.meta.dir, '../..')

export interface NetworkSources {
  network: string
  whitelistPeriphery: Record<string, string>
  deploymentFlat: Record<string, string>
  diamondPeriphery: Record<string, string>
  diamondFacets: Record<string, string>
}

export interface Mismatch {
  network: string
  kind: 'periphery' | 'facet'
  contract: string
  addresses: { source: string; address: string }[]
}

const isEmpty = (address?: string): boolean => !address || address.trim() === ''
const normalize = (address: string): string => address.trim().toLowerCase()

function checkContract(
  network: string,
  kind: Mismatch['kind'],
  contract: string,
  entries: { source: string; address?: string }[]
): Mismatch | null {
  const present = entries.filter(
    (e): e is { source: string; address: string } => !isEmpty(e.address)
  )
  if (present.length < 2) return null
  const reference = normalize(present[0].address)
  const disagrees = present.some((e) => normalize(e.address) !== reference)
  return disagrees ? { network, kind, contract, addresses: present } : null
}

export function findMismatches(sources: NetworkSources[]): Mismatch[] {
  const mismatches: Mismatch[] = []
  for (const s of sources) {
    const peripheryNames = new Set([
      ...Object.keys(s.whitelistPeriphery),
      ...Object.keys(s.diamondPeriphery),
    ])
    for (const name of peripheryNames) {
      const m = checkContract(s.network, 'periphery', name, [
        {
          source: 'config/whitelist.json',
          address: s.whitelistPeriphery[name],
        },
        {
          source: `deployments/${s.network}.json`,
          address: s.deploymentFlat[name],
        },
        {
          source: `deployments/${s.network}.diamond.json`,
          address: s.diamondPeriphery[name],
        },
      ])
      if (m) mismatches.push(m)
    }
    for (const name of Object.keys(s.diamondFacets)) {
      const m = checkContract(s.network, 'facet', name, [
        {
          source: `deployments/${s.network}.json`,
          address: s.deploymentFlat[name],
        },
        {
          source: `deployments/${s.network}.diamond.json`,
          address: s.diamondFacets[name],
        },
      ])
      if (m) mismatches.push(m)
    }
  }
  return mismatches
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

export function loadSources(repoRoot: string = REPO_ROOT): NetworkSources[] {
  const whitelistByNetwork =
    readJson<{
      PERIPHERY?: Record<string, { name: string; address: string }[]>
    }>(`${repoRoot}/config/whitelist.json`).PERIPHERY ?? {}

  const deploymentsDir = `${repoRoot}/deployments`
  const diamondNetworks = readdirSync(deploymentsDir)
    .filter((f) => f.endsWith('.diamond.json') && !f.includes('.staging'))
    .map((f) => f.replace('.diamond.json', ''))

  const networks = new Set<string>([
    ...Object.keys(whitelistByNetwork),
    ...diamondNetworks,
  ])

  const sources: NetworkSources[] = []
  for (const network of networks) {
    const whitelistPeriphery: Record<string, string> = {}
    for (const entry of whitelistByNetwork[network] ?? [])
      whitelistPeriphery[entry.name] = entry.address

    const flatPath = `${deploymentsDir}/${network}.json`
    const deploymentFlat: Record<string, string> = existsSync(flatPath)
      ? readJson<Record<string, string>>(flatPath)
      : {}

    const diamondPath = `${deploymentsDir}/${network}.diamond.json`
    let diamondPeriphery: Record<string, string> = {}
    const diamondFacets: Record<string, string> = {}
    if (existsSync(diamondPath)) {
      const diamond =
        readJson<{
          LiFiDiamond?: {
            Periphery?: Record<string, string>
            Facets?: Record<string, { Name?: string; Version?: string }>
          }
        }>(diamondPath).LiFiDiamond ?? {}
      diamondPeriphery = diamond.Periphery ?? {}
      for (const [address, info] of Object.entries(diamond.Facets ?? {}))
        if (info?.Name) diamondFacets[info.Name] = address
    }

    sources.push({
      network,
      whitelistPeriphery,
      deploymentFlat,
      diamondPeriphery,
      diamondFacets,
    })
  }
  return sources
}

function report(mismatches: Mismatch[]): void {
  for (const m of mismatches) {
    consola.error(`[${m.network}] ${m.kind} "${m.contract}" address mismatch:`)
    for (const a of m.addresses) consola.log(`    ${a.address}  (${a.source})`)
  }
}

if (import.meta.main) {
  const mismatches = findMismatches(loadSources())
  if (mismatches.length > 0) {
    report(mismatches)
    consola.error(
      `Found ${mismatches.length} address mismatch(es) across deployment files.`
    )
    process.exit(1)
  }
  consola.success('Deployment address consistency check passed.')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test script/tasks/checkDeploymentAddressConsistency.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Lint and type-check both files**

Run: `bunx eslint script/tasks/checkDeploymentAddressConsistency.ts script/tasks/checkDeploymentAddressConsistency.test.ts && bunx tsc-files --noEmit script/tasks/checkDeploymentAddressConsistency.ts script/tasks/checkDeploymentAddressConsistency.test.ts`
Expected: no errors. (The post-edit hook also runs prettier automatically.)

- [ ] **Step 6: Commit**

```bash
git add script/tasks/checkDeploymentAddressConsistency.ts script/tasks/checkDeploymentAddressConsistency.test.ts
git commit -m "feat(scripts): add deployment address consistency validator

Pure findMismatches() core plus loadSources() reader and a CLI that
exits 1 on any whitelist/deployment address mismatch. Unit-tested.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add `check:addresses` npm script and verify against the live repo

**Files:**

- Modify: `package.json` (scripts section, after the `healthcheck` line)

- [ ] **Step 1: Add the script entry**

In `package.json`, immediately after this line:

```json
    "healthcheck": "bunx tsx ./script/deploy/healthCheck.ts",
```

add:

```json
    "check:addresses": "bunx tsx ./script/tasks/checkDeploymentAddressConsistency.ts",
```

- [ ] **Step 2: Run against the live repository**

Run: `bun check:addresses; echo "exit=$?"`
Expected on a clean tree: `Deployment address consistency check passed.` and `exit=0`.

If it reports mismatches and exits 1: these are **pre-existing** inconsistencies on `main` (this branch is based on `main` and does not include PR #1890's whitelist changes). Do NOT auto-fix unrelated addresses. Capture the full output and surface it to the user as a separate finding; the gate itself is still working correctly. Continue the plan.

- [ ] **Step 3: Negative smoke test (confirm it actually fails on a mismatch)**

Pick any periphery contract that appears in both `config/whitelist.json` PERIPHERY and a deployment file for some network, change one hex character of its address in `config/whitelist.json`, then:

Run: `bun check:addresses; echo "exit=$?"`
Expected: it prints the `[<network>] periphery "<Contract>" address mismatch:` block and `exit=1`.

Revert the edit:

Run: `git checkout config/whitelist.json`
Run: `bun check:addresses; echo "exit=$?"`
Expected: back to `exit=0` (or back to the same pre-existing state from Step 2).

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore(scripts): add check:addresses npm script

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2.5: Scope checks to the networks the commit touches (`--staged`)

Added after Task 2's live run found ~26 pre-existing mismatches on `main`. The commit
gate must only check networks whose staged files changed; the default (no-flag) run
still scans all networks for manual/CI audits. Both periphery and facet checks block.

**Files:**

- Modify: `script/tasks/checkDeploymentAddressConsistency.ts`
- Test: `script/tasks/checkDeploymentAddressConsistency.test.ts`

**What to add (TDD — write the failing tests first):**

- A pure helper `affectedNetworks(stagedPaths: string[], changedWhitelistNetworks: string[]): Set<string>`:
  - For each path matching `^deployments/(.+)\.diamond\.json$` → add capture group.
  - For each path matching `^deployments/(.+)\.json$` (NOT `.diamond.json`, NOT `_deployments_log_file.json`, NOT containing `.staging`) → add capture group.
  - Add every entry of `changedWhitelistNetworks`.
  - Returns the union as a `Set<string>`.
- `loadSources(repoRoot?, filter?: Set<string>)` — when `filter` is provided, only build sources for networks in the filter.
- Git helpers (impure, used only by the CLI; do NOT import in tests):
  - `getStagedPaths(): string[]` → `git diff --cached --name-only --diff-filter=ACMR`, split on newlines, drop empties.
  - `getChangedWhitelistNetworks(): string[]` → if `config/whitelist.json` is staged, parse `git show :config/whitelist.json` (staged) and `git show HEAD:config/whitelist.json` (previous; treat a non-zero exit / missing file as "all whitelist networks changed"), then return the network keys whose `PERIPHERY[network]` array differs by `JSON.stringify`. If whitelist.json is not staged, return `[]`.
  - Use `execSync` from `node:child_process`; run with `cwd: REPO_ROOT`.
- CLI: parse `process.argv`. If `--staged` is present, compute `const scope = affectedNetworks(getStagedPaths(), getChangedWhitelistNetworks())`; if `scope.size === 0`, log a short "nothing to check" success and exit 0; otherwise `findMismatches(loadSources(REPO_ROOT, scope))`. Without `--staged`, keep the existing all-networks behaviour. Keep the existing try/catch + `consola` + `process.exit(1)`-on-mismatch.

**Unit tests to add** to the existing `describe`/new `describe` (alongside the 4 `findMismatches` tests):

```typescript
describe('affectedNetworks', () => {
  it('maps deployment and diamond paths to network names', () => {
    const result = affectedNetworks(
      ['deployments/arbitrum.json', 'deployments/base.diamond.json'],
      []
    )
    expect([...result].sort()).toEqual(['arbitrum', 'base'])
  })

  it('includes changed whitelist networks', () => {
    const result = affectedNetworks(['config/whitelist.json'], ['optimism'])
    expect([...result]).toEqual(['optimism'])
  })

  it('ignores non-deployment paths, the deployments log, and staging files', () => {
    const result = affectedNetworks(
      [
        'src/Foo.sol',
        'deployments/_deployments_log_file.json',
        'deployments/arbitrum.staging.json',
        'README.md',
      ],
      []
    )
    expect([...result]).toEqual([])
  })
})
```

**Verify:**

- `bun test script/tasks/checkDeploymentAddressConsistency.test.ts` → all pass (7 tests).
- `bunx eslint <both files> && bunx tsc-files --noEmit <both files>` → exit 0.
- Scoped behaviour: with nothing staged, `bunx tsx script/tasks/checkDeploymentAddressConsistency.ts --staged; echo exit=$?` → exits 0 ("nothing to check"). Stage one untouched-but-clean network's deployment file and confirm it does not report the 26 unrelated mismatches.

**Commit** (only the two script/test files):

```bash
git add script/tasks/checkDeploymentAddressConsistency.ts script/tasks/checkDeploymentAddressConsistency.test.ts
git commit -m "feat(scripts): add --staged scoping to address consistency check

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire the check into the husky pre-commit hook

**Files:**

- Modify: `.husky/pre-commit` (add staged-file detection near line 31/35; add check block before the final success banner near line 594)

- [ ] **Step 1: Add staged-file detection**

In `.husky/pre-commit`, find these two lines (around lines 30-31):

```bash
HAS_SOL_FILES="no"
HAS_TS_JS_FILES="no"
```

Change them to:

```bash
HAS_SOL_FILES="no"
HAS_TS_JS_FILES="no"
HAS_ADDRESS_FILES="no"
```

Then find this line (around line 35):

```bash
echo "$STAGED_FILES" | grep -qE '\.(ts|js|tsx)$' && HAS_TS_JS_FILES="yes"
```

and add immediately after it:

```bash
echo "$STAGED_FILES" | grep -qE '^config/whitelist\.json$|^deployments/' && HAS_ADDRESS_FILES="yes"
```

- [ ] **Step 2: Add the consistency-check block before the final banner**

Find the final banner line (around line 594):

```bash
printf '\n\033[1m━━━ All pre-commit checks passed! ━━━\033[0m\n'
exit 0
```

Insert this block immediately BEFORE that `printf` line:

```bash
# Deployment address consistency: whitelist.json <-> deployment logs.
# Runs only when whitelist or deployment files are staged. `--staged` scopes
# the check to the networks this commit touches. Pure JSON, no RPC.
if [ "$HAS_ADDRESS_FILES" = "yes" ]; then
  print_status "info" "Checking deployment address consistency..."
  ADDRESS_OUTPUT="$TEMP_DIR/address-consistency.out"
  if bunx tsx "$GIT_ROOT/script/tasks/checkDeploymentAddressConsistency.ts" --staged > "$ADDRESS_OUTPUT" 2>&1; then
    print_status "success" "Deployment address consistency passed"
  else
    printf '\n'
    cat "$ADDRESS_OUTPUT"
    printf '\n'
    print_status "error" "Deployment address mismatch detected. Aborting commit."
    exit 1
  fi
fi

```

- [ ] **Step 3: Syntax-check the hook**

Run: `bash -n .husky/pre-commit`
Expected: no output, exit 0.

- [ ] **Step 4: Manual hook test (positive + negative)**

Negative path — confirm a staged mismatch aborts the commit:

```bash
# Introduce a mismatch in a staged whitelist entry (pick a real periphery contract/network)
# edit config/whitelist.json: change one hex char of some periphery address
git add config/whitelist.json
git commit -m "test: should be blocked"
```

Expected: hook prints the mismatch block and `Deployment address mismatch detected. Aborting commit.`, commit does NOT happen (`git log -1` unchanged).

Then revert and confirm a clean commit passes the new check:

```bash
git checkout config/whitelist.json
git reset            # unstage
```

(Leave the actual commit of the hook change to Step 5.)

- [ ] **Step 5: Commit the hook change**

```bash
git add .husky/pre-commit
git commit -m "feat(husky): block commits on deployment address mismatch

Pre-commit runs checkDeploymentAddressConsistency.ts whenever
config/whitelist.json or deployments/** is staged; a mismatch aborts
the commit. Covers humans and agents.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

Note: this commit stages only `.husky/pre-commit`, so `HAS_ADDRESS_FILES` is `no` and the new check does not run on its own commit (no chicken-and-egg).

---

## Self-Review

**1. Spec coverage:**

- Invariant "agree where present, ignore empty/absent" → `checkContract` (filters empty, requires ≥2 present) — Task 1. ✓
- Periphery three-way (whitelist ∪ diamond names) → `findMismatches` periphery loop — Task 1. ✓
- Facet two-way (diamond Facets inverted vs flat log) → `findMismatches` facet loop + `loadSources` inversion — Task 1. ✓
- Case-insensitive + Tron-safe → `normalize` lowercases both sides — Task 1, covered by "all agree" test. ✓
- Offline, no RPC → only `fs` used. ✓
- Husky-only enforcement, conditioned on staged files → Task 3 detection + block. ✓
- Exit 1 on mismatch → CLI `process.exit(1)` — Task 1; husky aborts — Task 3. ✓
- Unit tests for clean/periphery/facet/empty cases → Task 1 Step 1. ✓
- Live run + negative smoke test → Task 2 Steps 2-3, Task 3 Step 4. ✓
- Out-of-scope (CI, Claude gate, "present in only one source" warnings) → not implemented, matches spec non-goals. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; every run step shows the command and expected output. ✓

**3. Type consistency:** `NetworkSources` and `Mismatch` shapes are identical across the script, the test imports, and `findMismatches`/`loadSources`/`checkContract` signatures. `findMismatches(sources: NetworkSources[]): Mismatch[]` used consistently in test and impl. ✓

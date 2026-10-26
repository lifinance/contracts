---
name: deprecate-contract
description: "Removes one or more facet or periphery contracts from the codebase (source, scripts, tests, docs, configs), keeps bridge-facet test coverage, opens the PR, and parks each facet's on-chain removal in the deferred cleanup queue. Use for \"deprecate <Contract>\". Network removal → deprecate-network."
usage: /deprecate-contract <ContractName1> [ContractName2] [ContractName3] ...
---

# Deprecate Contract

> **Usage**: `/deprecate-contract <ContractName1> [ContractName2] ...` (e.g. `/deprecate-contract RelayFacet Permit2Proxy`)

Contract names match exactly (case-sensitive). Contract not found → warn, continue with the
others; file not found → skip silently; invalid JSON → abort.

## Steps

1. **Discovery & validation**

   - `find src/ -name "{ContractName}.sol"` — any `src/` subdirectory.
   - Type: facet if the name contains "Facet", otherwise periphery.
   - Display contracts to be deprecated and wait for explicit go-ahead — also for a single
     contract, because step 6 writes parked tasks to MongoDB.

2. **Reference analysis** — files to remove:

   - `script/deploy/**/Deploy{ContractName}.s.sol`, `Update{ContractName}.s.sol`, and the
     `.zksync.s.sol` variants
   - `test/solidity/**/{ContractName}.t.sol`
   - `docs/{ContractName}.md`
   - `script/demoScripts/demo{ContractName}.ts`

   Config entries to remove:

   - `script/deploy/resources/deployRequirements.json`
   - `script/deploy/_targetState.json`, all networks/environments — facets under the
     `LiFiDiamond` key, periphery at root level. The value (`latest` or a version pin)
     doesn't matter; the whole entry goes ([docs/TargetState.md](../../docs/TargetState.md)).
   - `config/{contractNameLowercase}.json` — delete if contract-specific; if shared, remove
     only this contract's entries (e.g. `relay.json`: remove `relayReceiver`/`relaySolver`,
     keep `relayDepository` used by `RelayDepositoryFacet`).
   - `config/whitelist.json` PERIPHERY section (`config/whitelist.staging.json` is
     gitignored and not part of the PR)
   - `config/global.json`: `coreFacets` / `corePeriphery`, the contract's
     `whitelistPeripheryFunctions` and `whitelistPeripheryNetworks` entries, and any
     `facetPeripheryCouplings` entry naming it as key or `requires` target

3. **Test coverage preservation** (bridge facets only — never delete their tests without
   replacement)

   - Baseline: `forge coverage --report lcov --force --ir-minimum`, then
     `bunx tsx script/utils/filter_lcov.ts lcov.info lcov-filtered.info 'test/' 'script/'`;
     record line coverage.
   - Pick a similar bridge facet, in priority order: not deprecated; similar test structure
     (setup, organization, naming); similar features (native/ERC20, swap integration). None
     found → ask the user.
   - Port the relevant tests into that bridge's test file: update names, imports,
     selectors, constants, addresses, chain IDs; preserve logic, assertions, edge cases.
   - `forge test` — the adapted tests must pass.

4. **Removal** — delete the source, deploy scripts, docs, demo scripts and config entries
   from step 2; delete the test file only after a successful replacement (bridge facets).

5. **Post-removal**

   - Periphery: run `bun update-whitelist-periphery` once after all removals (failure →
     warn, don't abort).
   - Bridge facets: re-measure coverage. Final < baseline → require explicit user
     confirmation before proceeding.
   - `forge test` — all tests must pass. Failures are blocking: report them, do not mark
     the deprecation successful.
   - Summary of changes, including the coverage comparison.
   - Open the deprecation PR with `/create-pr` (it owns the Linear ticket, the template and
     its own confirm gate). Step 6 needs the URL it returns.

6. **Park the on-chain removal** (facets)

   Deprecation removes the facet from the codebase only; it stays registered and callable
   on every production diamond until a governance proposal removes it. That removal is
   **not proposed now** — it is parked into the deferred diamond-cleanup queue and drained
   into a timelock-wrapped Safe proposal later (riding the next rollout to that network).
   See [docs/DeferredDiamondCleanupQueue.md](../../docs/DeferredDiamondCleanupQueue.md)
   and [docs/FacetRemovalReconciliation.md](../../docs/FacetRemovalReconciliation.md).

   - One parked task per (facet, PRODUCTION network whose `deployments/<network>.json`
     lists it) — that log is the authoritative facet → address map. Read the diamond and
     facet addresses from it.
   - **Park last, after the deprecation PR exists** — each task requires the PR URL
     (`--prUrl`), shown to the signer:

     ```bash
     bunx tsx script/deploy/safe/enqueue-parked-task.ts \
       --network <network> \
       --facetName <FacetName> \
       --diamondAddress <diamond address from deployments/<network>.json> \
       --facetAddress <facet address from deployments/<network>.json> \
       --prUrl <deprecation PR URL>
     ```

     `--environment` defaults to `production`; v1 parks production removals only (the CLI
     rejects any other environment). Re-running for an already-parked (facet, network) is a
     no-op.
   - No Safe proposal is created now. The drain path (on-chain loupe →
     `buildDiamondCutRemoveCalldata` → timelock `scheduleBatch` → Safe → quorum) is
     unchanged, and core/machinery facets are refused by the queue's protected-name guard.
     Periphery is out of scope (de-register via the periphery flow).

7. **Remaining occurrences review**

   - Search the codebase for each contract name (excluding `node_modules`, `.git`, `out`,
     `cache`, `broadcast`, `typechain`, `lib`); group by file with line numbers and
     context.
   - **Deploy-log entries**: once a network's parked task is open (`queued`/`proposed`),
     its `deployments/<network>.json` facet→address entry and `deployments/<network>.diamond.json`
     entry **may be pruned in the deprecation PR** — the drain is address-keyed, and the
     queue-aware invariants (`no-unexpected-facets`, `no-stale-registered-facets`) report
     the still-routed facet as expected-pending; a routed address with neither a log entry
     nor an open task is what warns. A network with **no** open task keeps both entries. A
     task retiring as `cancelled` means no removal executed — the facet is live; restore
     (or keep) both entries for that network. `superseded` is different: the loupe already
     confirmed the facet gone, so its entries go. `updateDiamondLogs` regenerates a pruned
     diamond-log entry from the loupe until the removal executes — cosmetic churn, not a
     signal to restore ([docs/DeploymentLogs.md](../../docs/DeploymentLogs.md)).
   - `typechain/` hits are generated and regenerate.
   - Ask which to remove — file paths, `none`, `all`, or `deployments only` (subject to the
     deploy-log rule above) — and wait. If anything more is removed, re-run `forge test`.

8. **Final reminders**

   - Move the contract column(s) to the deprecated section of the
     [Product Target State Spreadsheet](https://docs.google.com/spreadsheets/d/1jX1wfFkSn1s19I_KzMA7vB1kfgGxXUv7kRqwUGJJLF4/edit#gid=0)
     (manual; product bookkeeping only — `script/deploy/_targetState.json` is the source of
     truth).
   - Review the step 7 search results.

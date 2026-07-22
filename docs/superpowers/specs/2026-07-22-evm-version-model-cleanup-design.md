# EVM/solc version model cleanup + cancun flip (EXSC-656, redesigned)

- **Ticket:** EXSC-656
- **Supersedes:** closed PRs #2094, #2104, #2105
- **Date:** 2026-07-22
- **Status:** design approved, pending spec review

## Problem

`config/networks.json` carries two version fields whose names no longer match how
they are used:

- **`deployedWithEvmVersion`** is *named* as a historical record ("what this
  network was deployed with") but since the March grouping change it is used
  **forward-looking**: it selects the build/deploy toolchain wave for the *next*
  deploy to that network. `deployGroupingHelpers.sh` maps the value to a solc pin
  (`london → 0.8.17`, `cancun → 0.8.29`) and rewrites `foundry.toml` per group
  before `forge build`. Name and behavior disagree.
- **`deployedWithSolcVersion`** has **no live code consumer**. The only reader,
  `getNetworkSolcVersion` in `script/playgroundHelpers.sh`, has zero callers.
  Deploy-time solc/evm logging comes from `getSolcVersion`/`getEvmVersion`, which
  read `foundry.toml`, not this field. solc is fully derivable from the EVM group.

Separately, block-explorer **re-verification** of an already-deployed contract
recompiles from the current `foundry.toml [profile.default]` and ignores the
per-contract toolchain recorded in the MongoDB `contract-deployments` collection.
`verifyContract()` passes no `--compiler-version` / `--evm-version` /
`--num-of-optimizations`. The batch re-verify loop
(`verifyAllUnverifiedContractsInLogFile`) even *reads* the recorded
`SOLC_VERSION` / `EVM_VERSION` / `OPTIMIZER_RUNS` per entry but never forwards
them. So re-verifying an old london-built contract while `foundry.toml` sits at
cancun/0.8.29 (its committed default on `main`) mismatches bytecode and fails.

## Goals

1. Make the `networks.json` field name reflect its real (forward-looking) meaning.
2. Remove the dead `deployedWithSolcVersion` field.
3. Fix re-verification to use each contract's recorded toolchain.
4. Move all cancun-capable chains from london to cancun so their next deploy ships
   cancun bytecode.

## Non-goals (explicit follow-ups)

- zkEVM re-verify toolchain overrides.
- `via_ir` handling in verification.
- Backfilling solc/evm for pre-logging records from on-chain CBOR metadata
  (the Case B fix, see below).
- `git checkout <gitCommitHash>` for source that has drifted since deploy.
- A standalone Mongo-driven `list-unverified` command.

## Design

One PR, three coordinated changes. Reuses ticket EXSC-656.

### 1. Rename + drop (hard rename, no backward-compat alias)

`deployedWithEvmVersion` → `targetEvmVersion` everywhere; delete
`deployedWithSolcVersion` everywhere. No transitional alias (per the repo's
"replace, don't deprecate" rule). No external readers of these two fields exist
outside `lifinance/contracts`; the `contracts-tron` fork picks up the rename on
its next sync from `main`.

In-repo edit sites:

- `config/networks.json` — rename the field in every entry; delete
  `deployedWithSolcVersion` from every entry.
- `script/deploy/resources/deployGroupingHelpers.sh` — `getNetworkEvmVersion`
  jq path + comment.
- `script/helperFunctions.sh` — jq path (~line 3025).
- `script/deploy/shared/constants.ts` — `n.deployedWithEvmVersion` (~line 91).
- `script/common/types.ts` — `INetwork.deployedWithEvmVersion` →
  `targetEvmVersion`; drop `INetwork.deployedWithSolcVersion`; rename the derived
  type `DeployedEvmVersionLabel` → `TargetEvmVersionLabel` (and its uses).
- `script/balances.ts` — local interface: rename field, drop
  `deployedWithSolcVersion`.
- `script/deploy/safe/deploy-safe.ts` — `networkConfig.deployedWithEvmVersion`
  (~line 401) + doc comment.
- `script/deploy/deployContractToNetworks.sh` — error string (~line 323).
- `script/deploy/tron/deploy-safe-tron.ts` — doc comment.
- `script/playgroundHelpers.sh` — delete the dead `getNetworkSolcVersion`
  function (and its `export -f`).
- `script/README_multiNetworkExecution.md` — field references + the
  solc-derivation notes.
- `.agents/commands/add-network.md` (and the `add-network` skill, if it embeds
  the field) — new-network template uses `targetEvmVersion`, no
  `deployedWithSolcVersion`.

### 2. DB-driven re-verification (minimal — optional overrides, option "a")

- `verifyContract()` gains three **optional** trailing params:
  `SOLC_VERSION_OVERRIDE`, `EVM_VERSION_OVERRIDE`, `OPTIMIZER_RUNS_OVERRIDE`.
  When set (non-zkEVM path only), append `--compiler-version` /
  `--evm-version` / `--num-of-optimizations` to the `forge verify-contract`
  command. When omitted or empty → today's behavior exactly (forge reads
  `foundry.toml [profile.default]`).
- `verifyAllUnverifiedContractsInLogFile` forwards the `$SOLC_VERSION`,
  `$EVM_VERSION`, `$OPTIMIZER_RUNS` it already extracts per entry into the call.
- The deploy-time verify path (`deploySingleContract.sh`) is **untouched**: it
  omits the overrides, so it keeps verifying against the freshly-built
  `foundry.toml`, which already matches.
- zkEVM verification path unchanged (out of scope).

**Case A** (old unverified contract *with* recorded solc/evm): today re-verify
fails because it uses `foundry.toml` (cancun); after this change it passes the
recorded london/0.8.17 and succeeds. **This change fixes Case A.**

**Case B** (old unverified contract *without* recorded solc/evm — pre-logging):
empty overrides → `foundry.toml` fallback, i.e. **behavior unchanged** from today.
Correctly re-verifying these requires the CBOR-metadata backfill, which is an
explicit follow-up. The flip in change 3 does *not* regress Case B, because the
re-verify path never consulted `deployedWithEvmVersion` — it already defaults to
the committed `foundry.toml` (cancun).

### 3. Flip cancun-capable chains london → cancun

Set `targetEvmVersion: "cancun"` for every currently-london, non-zkEVM chain in
`networks.json` **except** the documented exclusions. This reproduces #2094's
eligibility rule against current `main` (more robust than replaying #2094's stale
diff — e.g. `0g` is already cancun on `main`).

Exclusions stay on london:

- `nibiru`, `taiko`, `telos`, `viction` — opcode probe negative (transient
  storage / MCOPY not activated, or RPC unverifiable).
- `mantle` — its `devNotes` record LDA 1.11.0 cancun transaction failures and
  recommend `0.8.17`/london; a documented deployment failure overrides the probe.
- `tron`, `tronshasta` — TVM, separate toolchain.

The 39 chains to flip (46 currently-london non-zkEVM − 7 exclusions):

```
apechain arbitrum arbitrumsepolia avalanche base basesepolia blast boba botanix
bsc celo cronos etherlink flare fraxtal fuse gnosis gravity immutablezkevm kaia
linea lisk mainnet metis mode moonbeam opbnb optimism optimismsepolia pharos
polygon rootstock scroll sei sonic vana worldchain xdc xlayer
```

Only the *next* deploy on each flipped chain builds cancun bytecode; existing
on-chain facets are untouched. This list must be recomputed from `main` at
implementation time (chains may have been added/flipped since this spec) using
the rule "all london non-zkEVM chains minus the 7 exclusions".

## Validation

Agent-run static checks:

- `bash -n` + `shellcheck` + `shfmt -d` on every changed `.sh`.
- `bunx tsc-files --noEmit` on `script/common/types.ts` and `script/balances.ts`
  (and any TS whose types shift).
- `bun format` / `bun lint` per repo convention on touched files.
- `jq` consistency over `config/networks.json`:
  - every entry has `targetEvmVersion ∈ {london, cancun}`;
  - no entry retains `deployedWithEvmVersion` or `deployedWithSolcVersion`;
  - the 7 exclusions are still `london`.
- `forge build` sanity (no Solidity source changed, so `forge test` is unaffected).

Handoff (human / CI, cannot run headless here):

- One live re-verify of an *old london-built* contract on a now-cancun chain,
  through the patched `verifyAllUnverifiedContractsInLogFile`, to prove the
  `--compiler-version` / `--evm-version` overrides restore bytecode matching.
- Optional: a Mongo count of Case B records (unverified + no recorded solc/evm)
  to size the follow-up backfill.

## Risks

- **Missed edit site for the rename.** Mitigated by a repo-wide grep for both old
  field names as a completion gate (must return zero hits outside this spec/docs).
- **A flipped chain is not actually cancun-capable.** Mitigated by reusing the
  documented exclusion set and the empirical probe basis; only the next deploy is
  affected, and a bad flip surfaces immediately as a failed deploy, not silent
  breakage of existing contracts.
- **Case B re-verify still fails** until the CBOR backfill lands. Accepted and
  documented; not a regression (behavior unchanged for Case B).

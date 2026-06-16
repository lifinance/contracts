---
name: verify-contracts
description: Verify a deployed network's smart contracts on its block explorer and flip the MongoDB `verified` flag for each. Use this skill whenever a user asks to "verify the contracts for <network>", "verify contracts in PR #<N>", verify a fresh deployment on its explorer (blockscout / sourcify / etherscan), or fix contracts that show as unverified after a deploy. Drives the verified, working flow: source the deployment address map, ensure the worktree can compile, loop `verifyContract` over every address, then write the `verified:true` flag back to Mongo (which on-chain verification alone does NOT do). Even partial phrasings like "the deploy for X is showing unverified" or "mark these as verified in the logs" should trigger.
usage: /verify-contracts <network>  |  /verify-contracts PR #<N>
---

# Verify Contracts

**Goal**: every contract in `deployments/<network>.json` shows verified on the block explorer AND carries `verified:true` in the MongoDB deployment log. Those two facts are independent — the skill is not done until both hold.

## Conventions

- **`NETWORK`** — short network name as keyed in [`config/networks.json`](../../config/networks.json) (e.g. `base`, `arbitrum`, `mainnet`).
- **Address map** — [`deployments/<network>.json`](../../deployments): `{ "ContractName": "0x…", … }`. The authoritative list of what to verify.
- **`ENVIRONMENT`** — `production` unless the deploy was a staging run.

## Two gotchas that waste the most time — read first

1. **Submodules must be initialized in the working checkout.** If `lib/` is empty, `forge` cannot compile and verification fails with the misleading `Details: Fail - Unable to verify`, preceded by many `No such file or directory` errors for `lib/...`. A fresh worktree does **not** inherit submodules. Always run `git submodule update --init --recursive` before the first `verifyContract`.

2. **On-chain verification ≠ the Mongo `verified` flag.** Calling `verifyContract` directly verifies the bytecode on the explorer but does **not** write `verified:true` to the MongoDB master log — only `logContractDeploymentInfo()` (→ `update-deployment-logs.ts add`) does that, and the direct loop bypasses it. So after the on-chain loop you must flip the Mongo flags explicitly (Step 5). Skip this and the contracts look unverified in every report that reads Mongo, even though the explorer shows them green.

## Workflow

### 1. Get the deployment address map onto disk

- **By network** (already deployed, files on `main`): use `deployments/<network>.json` in the current checkout.
- **By PR** (deploy PR — the deployment files exist only on the PR branch): check out that branch in a worktree:

  ```bash
  ~/.claude/scripts/contracts-wt-add.sh <pr-branch>   # symlinks .env; never copy it
  ```

  Resolve the branch with `gh pr view <N> --json headRefName -q .headRefName` if you only have the PR number.

### 2. Make the checkout compilable

```bash
git submodule update --init --recursive   # gotcha #1 — non-negotiable in a fresh worktree
```

The repo TS scripts (Step 5) also need deps: run `bun install` if `node_modules` is absent. The TS log scripts filter Mongo by `--network` as a plain string, so if a worktree lacks deps you can run **Step 5 from the main checkout** instead — only the on-chain loop (Step 4) needs this checkout's `src/` + `lib/`.

### 3. Confirm verifier config matches the deployment

The on-chain loop relies on three sources already being correct for `NETWORK`. Verify, don't assume:

- [`foundry.toml`](../../foundry.toml) — `NETWORK` present in **both** `[rpc_endpoints]` and `[etherscan]`. The `[etherscan]` entry carries the verifier `url`, `chain`, and `verifier` (`blockscout` | `sourcify` | `custom`/etherscan).
- [`config/networks.json`](../../config/networks.json) — `verificationType` and `explorerApiUrl` for `NETWORK`.
- `[profile.default]` compiler settings (`solc_version`, `evm_version`, `optimizer_runs`) match what the contracts were deployed with. A mismatch is a silent source of "Unable to verify" on etherscan-type verifiers.

### 4. Verify each contract on-chain

`verifyContract <network> <contract> <address> <constructorArgs>` lives in [`script/helperFunctions.sh`](../../script/helperFunctions.sh). Source `.env` then the helper, then loop over the address map.

**Key fact: blockscout and sourcify match RUNTIME bytecode, so constructor args are NOT required — pass `""`.** (etherscan-type verifiers can need them; the helper skips invalid/empty args safely either way.)

```bash
source .env
source script/helperFunctions.sh

NETWORK=<network>
DEPLOYMENTS="deployments/${NETWORK}.json"

while IFS=$'\t' read -r CONTRACT ADDRESS; do
  echo "Verifying ${CONTRACT} @ ${ADDRESS}"
  verifyContract "$NETWORK" "$CONTRACT" "$ADDRESS" ""
done < <(jq -r 'to_entries[] | "\(.key)\t\(.value)"' "$DEPLOYMENTS")
```

Why the direct loop and not the menu: `script/scriptMaster.sh` option 8 (`verifyAllUnverifiedContractsInLogFile`) does both the on-chain verify and the Mongo write-back — but only for entries in the **local** `deployments/_deployments_log_file.json` cache, which for a freshly-deployed network is usually empty or stale. The direct loop over the deployment JSON is the reliable path; Step 5 covers the write-back it skips.

### 5. Write the `verified` flag back to MongoDB

These TS scripts need `node_modules` (`bun install`) and `MONGODB_URI` in `.env`.

1. List the network's records with versions, bypassing the local cache:

   ```bash
   bunx tsx script/deploy/query-deployment-logs.ts list \
     --env production --network "$NETWORK" --limit 200 --no-use-cache --format json
   ```

2. For each contract you verified, partial-update the flag (touches only `verified`, preserves all other fields):

   ```bash
   bunx tsx script/deploy/update-deployment-logs.ts update \
     --env production --network "$NETWORK" \
     --contract <Name> --version <ver> --address <addr> --verified true
   ```

**Match records by ADDRESS (case-insensitive)** to the deployment map — a contract name can have multiple versions in Mongo (e.g. a superseded facet). Only flip the versions you actually verified on-chain; never blindly mark a superseded version `true` — its older bytecode won't match current `src/` and the claim would be false.

### 6. Verify the outcome

Re-query with `--no-use-cache` and confirm the verified count matches the deployment map:

```bash
bunx tsx script/deploy/query-deployment-logs.ts list \
  --env production --network "$NETWORK" --limit 200 --no-use-cache --format json \
  | jq '[.[] | {contract, version, verified}]'
```

Report any record still `false` and why (e.g. superseded version intentionally left, or a verifier that genuinely failed). Don't claim "all verified" unless both the explorer and this re-query agree.

## Failure modes

| What fails | What to do |
|---|---|
| `Details: Fail - Unable to verify` with `lib/...: No such file or directory` above it | Submodules not initialized — `git submodule update --init --recursive` (gotcha #1). |
| `Unable to verify` on an etherscan-type verifier, `lib/` is fine | Compiler profile mismatch — re-check `solc_version` / `evm_version` / `optimizer_runs` in `[profile.default]` against the deploy (Step 3). |
| `No verifier URL found for network` | `NETWORK` missing from the `[etherscan]` section of `foundry.toml` (Step 3). |
| Explorer shows green but reports still say unverified | Mongo flag never written — run Step 5. This is gotcha #2. |
| `update-deployment-logs.ts` can't find the record | Wrong `--version` or `--address` — list with `--no-use-cache` first and match by address. |
| TS script errors on `MONGODB_URI` | Not set in `.env`; these scripts can be run from the main checkout where it is configured. |

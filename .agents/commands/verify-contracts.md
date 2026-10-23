---
name: verify-contracts
description: "Verifies every contract in deployments/<network>.json on its block explorer, then writes the MongoDB verified flag, which explorer verification alone does not. Use for \"verify the contracts for <network>\" or \"showing unverified\". One contract version across a rollout → deploy-contract Phase 3c."
usage: /verify-contracts <network>  |  /verify-contracts PR #<N>
---

# Verify Contracts

**Goal**: every contract in `deployments/<network>.json` (the authoritative address map; `<network>` as keyed in `config/networks.json`) shows verified on the block explorer AND carries `verified:true` in the MongoDB deployment log. Not done until both hold.

## Gotchas

1. **Submodules must be initialized in the working checkout.** With an empty `lib/`, verification fails with the misleading `Details: Fail - Unable to verify`, preceded by `No such file or directory` errors for `lib/...`. A fresh worktree does not inherit submodules.

2. **On-chain verification ≠ the Mongo `verified` flag.** `verifyContract` verifies on the explorer but does **not** write `verified:true` — only `logContractDeploymentInfo()` (→ `update-deployment-logs.ts add`) does, and the direct loop bypasses it. Step 5 flips the flags; skip it and every Mongo-reading report shows the contracts unverified.

## Workflow

### 1. Get the deployment address map onto disk

- **By network** (already deployed, files on `main`): use `deployments/<network>.json` in the current checkout.
- **By PR** (deploy PR — the deployment files exist only on the PR branch): check it out in the current checkout or worktree with `gh pr checkout <N>`. The scripts below read `.env` from that checkout's root.

### 2. Make the checkout compilable

```bash
git submodule update --init --recursive   # gotcha 1
```

The repo TS scripts (Step 5) also need deps: run `bun install` if `node_modules` is absent. The TS log scripts filter Mongo by `--network` as a plain string, so if a worktree lacks deps you can run **Step 5 from the main checkout** instead — only the on-chain loop (Step 4) needs this checkout's `src/` + `lib/`.

### 3. Confirm verifier config matches the deployment

The on-chain loop relies on three sources already being correct for `<network>`. Verify, don't assume:

- [`foundry.toml`](../../foundry.toml) — `<network>` present in **both** `[rpc_endpoints]` and `[etherscan]`. The `[etherscan]` entry carries the verifier `url`, `chain`, and `verifier` (`blockscout` | `sourcify` | `custom`/etherscan).
- [`config/networks.json`](../../config/networks.json) — `verificationType` and `explorerApiUrl` for `<network>`.
- The active Foundry profile matches what the contracts were built with. A network whose `config/networks.json` entry has `"targetEvmVersion": "london"` deploys under `[profile.solc_floor]` (solc 0.8.17 / london), so run Step 4 as `FOUNDRY_PROFILE=solc_floor ./script/tasks/verifyNetworkContracts.sh <network>`. zkEVM networks (`isZkEVM` in `networks.json`) need nothing extra: `verifyContract` scopes `FOUNDRY_PROFILE=zksync` to its own command. Every other network uses `[profile.default]`. A mismatch is a silent source of "Unable to verify" on etherscan-type verifiers.

### 4. Verify each contract on-chain

`script/tasks/verifyNetworkContracts.sh` runs `verifyContract` (from
[`script/helperFunctions.sh`](../../script/helperFunctions.sh)) over every entry in the address
map. On mainnet non-zkEVM networks `verifyContract` also submits each contract to sourcify.dev
(best-effort, a warning on failure; the ERC-7730 clear-signing sync needs it).

**Key fact: blockscout and sourcify match RUNTIME bytecode, so constructor args are NOT required** — the script passes `""`. (etherscan-type verifiers can need them; the helper skips invalid/empty args safely either way.)

Run it from the repo root as a plain command (no `&&`, pipes, heredocs or `source` — a
worktree-isolated session refuses those):

```bash
./script/tasks/verifyNetworkContracts.sh <network> [<env>]
```

`<env>` defaults to `production`; pass `staging` for a staging deploy so it reads
`deployments/<network>.staging.json`.

| Exit | Meaning | Next |
|---|---|---|
| `0` | every contract verified on the explorer | Step 5 |
| `1` | unreadable/empty deployment file, or ≥1 contract failed (each printed as `FAILED:`) | fix per Failure modes; flag only what verified |
| `2` | network is in `DO_NOT_VERIFY_IN_THESE_NETWORKS` | **STOP** — skip Steps 5–6, report the network as excluded; writing `verified:true` would be false |

Don't use `script/scriptMaster.sh` option 8 (`verifyAllUnverifiedContractsInLogFile`) instead: it only covers entries in the local `deployments/_deployments_log_file.json` cache, which for a freshly-deployed network is usually empty or stale.

### 5. Write the `verified` flag back to MongoDB

These TS scripts need `node_modules` (`bun install`) and `MONGODB_URI` in `.env`; they load `.env` themselves. `<env>` is `production`, or `staging` for a staging deploy.

1. List the network's records with versions, bypassing the local cache:

   ```bash
   bunx tsx script/deploy/query-deployment-logs.ts list \
     --env <env> --network <network> --limit 200 --no-use-cache --format json
   ```

2. For each contract you verified, partial-update the flag (touches only `verified`, preserves all other fields):

   ```bash
   bunx tsx script/deploy/update-deployment-logs.ts update \
     --env <env> --network <network> \
     --contract <Name> --version <ver> --address <addr> --verified true
   ```

**Match records by ADDRESS (case-insensitive)** to the deployment map — a contract name can have multiple versions in Mongo (e.g. a superseded facet). Only flip the versions you actually verified on-chain; never blindly mark a superseded version `true` — its older bytecode won't match current `src/` and the claim would be false.

### 6. Verify the outcome

Re-run the Step 5.1 query and check each record's `verified` flag, matched to the deployment map by address. Report any record still `false` and why (e.g. superseded version intentionally left, or a verifier that genuinely failed). Don't claim "all verified" unless both the explorer and this re-query agree.

## Failure modes

| What fails | What to do |
|---|---|
| `Unable to verify` on an etherscan-type verifier, `lib/` is fine | Compiler profile mismatch — a london network needs `FOUNDRY_PROFILE=solc_floor` (Step 3); otherwise re-check `solc_version` / `evm_version` / `optimizer_runs` in `[profile.default]` against the deploy. |
| `No verifier URL found for network` | `NETWORK` missing from the `[etherscan]` section of `foundry.toml` (Step 3). |
| `update-deployment-logs.ts` can't find the record | Wrong `--version` or `--address` — list with `--no-use-cache` first and match by address. |
| TS script errors on `MONGODB_URI` | Not set in this checkout's `.env`; ask the user to add it. |

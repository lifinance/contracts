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
- **By PR** (deploy PR — the deployment files exist only on the PR branch): check out that branch in a worktree. Resolve the branch with `gh pr view <N> --json headRefName -q .headRefName` if you only have the PR number, then:

  ```bash
  PR_BRANCH=$(gh pr view <N> --json headRefName -q .headRefName)
  git worktree add ../contracts-wt-verify "$PR_BRANCH"
  ln -s "$(git rev-parse --show-toplevel)/.env" ../contracts-wt-verify/.env   # symlink, never copy
  ```

  The TS scripts (Steps 5–6) read `MONGODB_URI` from `.env`; the symlink reuses the main checkout's secrets. If you keep a personal `contracts-wt-add.sh` helper it does the same `.env` symlink for you, but it is not required.

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

`verifyContract <network> <contract> <address> <constructorArgs>` lives in [`script/helperFunctions.sh`](../../script/helperFunctions.sh). Source `.env` then the helper, then loop over the address map. On mainnet non-zkEVM networks it also submits each contract to sourcify.dev (best-effort, a warning on failure; the ERC-7730 clear-signing sync needs it). Its return value is the explorer result only.

**Key fact: blockscout and sourcify match RUNTIME bytecode, so constructor args are NOT required — pass `""`.** (etherscan-type verifiers can need them; the helper skips invalid/empty args safely either way.)

```bash
set -a; source .env; set +a   # `set -a` exports, so Step 5's `bunx tsx` children see MONGODB_URI
export NETWORK=<network>
export ENVIRONMENT=production   # "staging" for a staging deploy — Steps 5-6 reuse this
```

Then run the exclusion gate as its own command. **A non-zero exit here means STOP: skip Steps
4, 5 and 6 entirely and report the network as excluded.** Do not continue to the verify loop.

```bash
bash <<'BASH'
case ",${DO_NOT_VERIFY_IN_THESE_NETWORKS:-}," in
*,"$NETWORK",*)
  echo "STOP: ${NETWORK} is in DO_NOT_VERIFY_IN_THESE_NETWORKS — nothing to verify. Skip Steps 4-6."
  exit 1
  ;;
esac
echo "${NETWORK} is not excluded — proceed with the verify loop"
BASH
```

Only once that gate exits 0, run the loop:

```bash
bash <<'BASH'
source script/helperFunctions.sh

DEPLOYMENTS="deployments/${NETWORK}.json"
CONTRACTS=$(jq -r 'to_entries[] | "\(.key)\t\(.value)"' "$DEPLOYMENTS") ||
  { echo "Cannot read ${DEPLOYMENTS} — missing or not valid JSON"; exit 1; }
[ -n "$CONTRACTS" ] || { echo "${DEPLOYMENTS} lists no contracts"; exit 1; }

FAILED=0
while IFS=$'\t' read -r CONTRACT ADDRESS; do
  echo "Verifying ${CONTRACT} @ ${ADDRESS}"
  verifyContract "$NETWORK" "$CONTRACT" "$ADDRESS" "" ||
    { echo "FAILED: ${CONTRACT} @ ${ADDRESS}"; FAILED=$((FAILED + 1)); }
done <<< "$CONTRACTS"

[ "$FAILED" -eq 0 ] || { echo "${FAILED} contract(s) failed verification"; exit 1; }
BASH
```

Why the `bash` heredoc: `script/helperFunctions.sh` is bash (`${!VAR}` indirect expansion,
`read -ra`) and dies on those under the zsh this session runs. `NETWORK`/`ENVIRONMENT` are
exported rather than set inside the heredoc so Steps 5-6 still see them in the outer shell.
Why `set -a` around `source .env`: plain `source` defines shell variables, which a child
process does not inherit — Step 5's TS scripts import no `dotenv`, so they read `MONGODB_URI`
from the environment or die. Sourcing the helper used to do this for you (it wraps its own
`.env` read the same way), but it now runs inside the heredoc, so the outer shell has to.
Run from the repo root — the helper sources `.env` and its siblings by relative path.
`verifyContract` returns 1 per failed contract, and a loop's status is only its last
iteration's, so the failures are counted and re-raised at the end — otherwise one contract
failing early and a later one succeeding would exit 0 on an incomplete verification. The
count survives the loop because the input is a here-string, not a pipe.
Why `jq` runs into a variable first rather than feeding the loop from `< <(jq …)`: a process
substitution discards `jq`'s exit status, so a missing or malformed `deployments/<network>.json`
gives the loop nothing to read, leaves `FAILED` at 0 and exits 0 having verified nothing — the
same false success the network gate above prevents. A command substitution propagates the
status, and the emptiness check catches the valid-but-empty `{}` that a clean `jq` still
allows through.
Why the `DO_NOT_VERIFY_IN_THESE_NETWORKS` check is a separate command and not a `case` inside
the verify heredoc: `verifyContract` returns 1 for an excluded network too
(`script/helperFunctions.sh`), which the counter cannot tell from a real failure — without the
short-circuit, `gnosis` (shipped in `.env.example`) reports every contract as failed. But an
`exit` inside the heredoc only ends that child shell, so a gate spelled `exit 0` there hands
back a *successful* block and Step 5 goes on to write `verified:true` for a network where no
`verifyContract` call ever ran — the exact silent-false-result failure this command exists to
prevent. Standalone and exiting non-zero, the gate cannot be walked past: skipping Steps 4-6
is the whole point, since nothing was verified on-chain and the Mongo flag would be a lie.

Why the direct loop and not the menu: `script/scriptMaster.sh` option 8 (`verifyAllUnverifiedContractsInLogFile`) does both the on-chain verify and the Mongo write-back — but only for entries in the **local** `deployments/_deployments_log_file.json` cache, which for a freshly-deployed network is usually empty or stale. The direct loop over the deployment JSON is the reliable path; Step 5 covers the write-back it skips.

### 5. Write the `verified` flag back to MongoDB

These TS scripts need `node_modules` (`bun install`) and `MONGODB_URI` in `.env`.

1. List the network's records with versions, bypassing the local cache:

   ```bash
   bunx tsx script/deploy/query-deployment-logs.ts list \
     --env "$ENVIRONMENT" --network "$NETWORK" --limit 200 --no-use-cache --format json
   ```

2. For each contract you verified, partial-update the flag (touches only `verified`, preserves all other fields):

   ```bash
   bunx tsx script/deploy/update-deployment-logs.ts update \
     --env "$ENVIRONMENT" --network "$NETWORK" \
     --contract <Name> --version <ver> --address <addr> --verified true
   ```

**Match records by ADDRESS (case-insensitive)** to the deployment map — a contract name can have multiple versions in Mongo (e.g. a superseded facet). Only flip the versions you actually verified on-chain; never blindly mark a superseded version `true` — its older bytecode won't match current `src/` and the claim would be false.

### 6. Verify the outcome

Re-query with `--no-use-cache` and confirm the verified count matches the deployment map:

```bash
bunx tsx script/deploy/query-deployment-logs.ts list \
  --env "$ENVIRONMENT" --network "$NETWORK" --limit 200 --no-use-cache --format json \
  | jq '[.data[] | {contract: .contractName, version, verified}]'
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

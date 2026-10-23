---
name: deploy-contract-tron
description: "Deploys a facet/periphery contract to Tron (tron/tronshasta) from the contracts-tron fork with the TronWeb scripts, verifies on Tronscan, and PRs the deploy logs to upstream lifinance/contracts, never the fork. Use for \"deploy <Contract> to tron\". EVM → deploy-contract."
usage: /deploy-contract-tron <ContractName> <tron|tronshasta...>
---

# Deploy Contract to Tron

Tron has no Foundry support (no `deployContractToNetworks.sh`, no CREATE3): it uses the TronWeb scripts in `script/deploy/tron/`, run from the separate fork repo `lifinance/contracts-tron`. Requires `gh`, `bun`, and TRX in the deployer wallet.

`main` in `lifinance/contracts` carries zero Tron branching; the Tron USDT fix (a bypass in `LibAsset.transferERC20` + a `WithdrawablePeriphery` re-route) lives only in the fork. Code flows one-way `contracts` → `contracts-tron`; deploy logs flow back via a PR against upstream — never a direct commit to the fork. Rationale, exact delta, sync mechanism: `docs/TronFork.md`.

## Phase 0 — Locate the `contracts-tron` checkout

A normal session is rooted in `contracts`, but every step in this skill except Phase 5 must run from a **`contracts-tron`** working copy — a different clone, not a worktree of this repo (worktrees share one `.git`; forks don't).

1. **Find it.** Check, in order: `$CONTRACTS_TRON_PATH` if set, then a sibling directory next to the current repo root (`../contracts-tron`). Use the first that exists and has `origin` pointing at `lifinance/contracts-tron`.
2. **Clone it if missing.**

   ```bash
   gh repo clone lifinance/contracts-tron ../contracts-tron
   ln -s "$(git rev-parse --show-toplevel)/.env" ../contracts-tron/.env   # symlink, never copy — reuses this checkout's secrets
   ```

3. **`cd` into it** for the rest of Phase 0 through Phase 4. All commands below assume the working directory is the `contracts-tron` checkout.

## Phase 0b — Preflight: branch, sync, delta

1. **Confirm you're in `contracts-tron`, not `contracts`, and on `main`.**

   ```bash
   git remote get-url origin | grep -q 'contracts-tron' || { echo "not in contracts-tron — abort"; exit 1; }
   git rev-parse --abbrev-ref HEAD   # must be main for a production deploy
   ```

2. **Check the fork is synced for the contract you're about to deploy.** If upstream `contracts:main` has changes to `<Contract>` (or to `LibAsset`/`WithdrawablePeriphery`) not yet in the fork, stop and merge the pending `sync/upstream-YYYY-MM-DD` PR first (or open one) — do not deploy stale code.

3. **Verify the `-tron` delta survived the last sync.** After any sync, confirm the bypass branch is still present:

   ```bash
   grep -q "TRON_USDT" src/Libraries/LibAsset.sol || { echo "Tron USDT bypass missing from LibAsset — sync broke the delta"; exit 1; }
   ```

   If missing, the sync merge dropped the fork's delta — resolve before deploying; do not deploy without the bypass on a chain where USDT is effectively all volume.

## Phase 1 — Versioning gate

Audits are keyed by `ContractName` + `@custom:version`; one version must map to exactly one bytecode.

- Contract identical to the synced `main` baseline → same version (e.g. `2.1.3`).
- Contract differs in the fork → `<main-version>-tron` (e.g. `2.1.3-tron`).
- Redeploying against the same `main` baseline with further Tron-only changes → append a revision (`2.1.3-tron-r2`, `-r3`, ...).
- Never bump to `2.2.0-tron` unless `main` is actually at `2.2.0` and the fork has synced to that baseline.

Check the repo version before proceeding: `grep -m1 "@custom:version" src/Facets/<Contract>.sol` (or `src/Periphery/...`).

## Phase 2 — Confirm plan

Present: contract + version, target network(s) (`tron` and/or `tronshasta`), and which deploy scripts will run. Wait for explicit go-ahead — Tron deploys cost real TRX (Energy + Bandwidth), and production deploys go straight onto mainnet with no Safe-proposal buffer for the deploy step itself.

## Phase 3 — Run the deploy scripts (in order)

**`PRODUCTION` alone picks the network and the key.** The scripts ignore `NETWORK`: `getEnvironment()` (`script/utils/utils.ts`) reads `PRODUCTION`, and `PRODUCTION=true` means `tron` with `PRIVATE_KEY_PRODUCTION` (deployerWallet), anything else means `tronshasta` with `PRIVATE_KEY` (devWallet). Both keys come from `.env`; an exported `PRODUCTION` wins over the `.env` value. Set it explicitly for every run, and check the network the script logs before it broadcasts:

```bash
export PRODUCTION=true    # tron (mainnet); PRODUCTION=false (tronshasta) only for scripts that support it

bunx tsx script/deploy/tron/deploy-core-facets.ts
bunx tsx script/deploy/tron/register-facets-to-diamond.ts
# only the ones relevant to <Contract>'s type:
bunx tsx script/deploy/tron/deploy-and-register-periphery.ts
bunx tsx script/deploy/tron/deploy-and-register-symbiosis-facet.ts
bunx tsx script/deploy/tron/deploy-and-register-allbridge-facet.ts
bunx tsx script/deploy/tron/deploy-and-register-near-intents-facet.ts
bunx tsx script/deploy/tron/deploy-and-register-eco-facet.ts
bunx tsx script/deploy/tron/deploy-and-register-layerswap-facet.ts   # tron only: exits unless PRODUCTION=true
bunx tsx script/deploy/tron/deploy-and-register-lifi-intent-escrow-facet-v2.ts
```

Each script reads the network config, deploys via `TronContractDeployer` (CREATE-equivalent, not CREATE3 — Tron has no CREATE3 factory support here), estimates Energy/Bandwidth with a safety margin, and updates `deployments/tron.json` / `deployments/tron.diamond.json` in the working tree.

**The scripts build first.** They deploy the artifact in `out/` but label it with the source file's `@custom:version`, so every script that reads `out/` (the deploy scripts, `register-facets-to-diamond.ts` and `transfer-ownership-to-timelock.ts`) first runs `forge build --skip 'test/**'` with `FOUNDRY_*` overrides removed and `FOUNDRY_PROFILE=default` set, so `[profile.default]` applies even when `.env` names another profile. It then refuses unless every `src/` artifact records the default profile's solc version, EVM version and optimizer runs. A failed build or check stops the run before anything is broadcast.

**Keep the fork's `deployments/` across runs.** The scripts write `deployments/tron.json` / `tron.diamond.json` at deploy time and again at propose time. Resetting the fork's `deployments/` between runs of the same rollout (e.g. `git checkout -- deployments/`) drops those writes, so a later `deploy-and-register-periphery.ts --registerOnly` run reads the old address and reports "already correctly registered" without proposing the new one.

**Deployer wallet, not devWallet, on mainnet.** Production deploys run from `deployerWallet` (`config/global.json` → `tronWallets`); deployment Energy is rented from a rental service, not funded by delegation. Never hard-code the address; always read it from `global.json`, and check its TRX balance before Phase 3.

## Phase 4 — Verify on Tronscan

`forge verify-contract` cannot target Tron. This phase covers production deploys only: a `PRODUCTION=false` run logs to `deployments/<network>.staging.json`, while `verify-tron-contracts.ts` reads `deployments/<network>.json` and flags production records, so for a staging deploy it fails or verifies a stale production address. Skip it there and report the staging deploy as unverified. Run `verify-tron-contracts.ts` from the fork checkout, as in Phase 3: it reads `deployments/<network>.json` from the working directory, which is where Phase 3 wrote the new address, and `--repo-root .` flattens sources from the code that was deployed:

```bash
bunx tsx script/deploy/tron/verify-tron-contracts.ts --network <tron|tronshasta> --repo-root . --only <Contract>
```

It is the only Tron path that sets the MongoDB `verified` flag, so a manual Tronscan upload leaves the record unverified. A record that fails to flag ends the run non-zero; re-run that contract. Flags and the browser fallback: `docs/TronFork.md` → "Contract verification (Tronscan)".

## Phase 5 — PR the deploy logs to *upstream*, never the fork

The histories are unrelated enough that cherry-picking is the wrong tool — **copy the two generated JSON files as plain data** from the `contracts-tron` checkout into a fresh branch of `contracts`. A deploy-log PR opened against `contracts-tron` → close it and re-open against upstream.

```bash
# capture the fork commit before leaving it — goes in the PR body for re-verification
TRON_COMMIT=$(git -C ../contracts-tron rev-parse HEAD)

# back in the contracts checkout (this repo)
git checkout -b deploy-tron-<contract>-<date> origin/main
cp ../contracts-tron/deployments/tron.json deployments/tron.json
cp ../contracts-tron/deployments/tron.diamond.json deployments/tron.diamond.json
```

Then delegate the commit / template / Linear ticket / push / create mechanic to `/create-pr`, passing:

- **files to stage**: `deployments/tron.json`, `deployments/tron.diamond.json` (nothing else).
- **title / commit message**: `chore(<Contract>): deploy vX.Y.Z-tron to tron`.
- **body** (the "Why"): deploy-log update from `contracts-tron`, fork commit `$TRON_COMMIT`.

The fork commit hash in the PR body (it flows into MongoDB via deploy-log ingestion) is what lets someone re-verify bytecode later from that exact fork commit.

Once merged upstream, these logs reach `contracts-tron` again on the next upstream→fork sync PR — do not also commit them directly to the fork's `main`.

## Output

Report: contract + version, network(s), deployed address(es), Tronscan verification status, and the upstream PR URL (or explicit note that Phase 5 is still pending and who owns it).

## Failure modes

- No `contracts-tron` checkout and no `gh` access to clone one → stop and ask; never run the TronWeb steps from `contracts` — the `-tron` delta doesn't exist there.
- Insufficient deployer TRX → stop before Phase 3; fund `tronWallets.deployerWallet` (or `devWallet` for `tronshasta`) or rent Energy first.
- Logged network differs from the plan → stop before anything broadcasts; `PRODUCTION` is wrong for this run.

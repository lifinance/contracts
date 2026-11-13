---
name: deploy-contract-tron
description: "Deploys a facet/periphery contract to Tron (tron/tronshasta) from the contracts-tron fork with the TronWeb scripts, verifies on Tronscan, and brings the deploy log back to upstream lifinance/contracts, never the fork. Use for \"deploy <Contract> to tron\". EVM → deploy-contract."
usage: /deploy-contract-tron <ContractName> <tron|tronshasta...>
---

# Deploy Contract to Tron

Tron has no Foundry support (no `deployContractToNetworks.sh`, no CREATE3): it uses the TronWeb scripts in `script/deploy/tron/`, run from the separate fork repo `lifinance/contracts-tron`. Requires `gh`, `bun`, and TRX in the deployer wallet.

`main` in `lifinance/contracts` carries zero Tron branching; the Tron USDT fix (a bypass in `LibAsset.transferERC20` + a `WithdrawablePeriphery` re-route) lives only in the fork. Code flows one-way `contracts` → `contracts-tron`; deploy logs flow back via a PR against upstream — never a direct commit to the fork. Rationale, exact delta, sync mechanism: `docs/TronFork.md`.

**Production (`tron`) runs inside `/multisig-rollout`.** This skill deploys, proposes and verifies; the signing hand-off, signature check and `#dev-sc-multisig-proposals` thread are `/multisig-rollout` Phases 4–8. Invoked directly for `tron`, stop and start `/multisig-rollout <Contract>` instead; it calls back here and resumes at its Phase 4 after Phase 5. A `tronshasta` run stays here end to end.

## Phase 0 — Locate the `contracts-tron` checkout

A normal session is rooted in `contracts`, but every step in this skill except Phase 5 must run from a **`contracts-tron`** working copy — a different clone, not a worktree of this repo (worktrees share one `.git`; forks don't).

1. **Find it.** Check, in order: `$CONTRACTS_TRON_PATH` if set, then a sibling directory next to the current repo root (`../contracts-tron`). Use the first that exists and has `origin` pointing at `lifinance/contracts-tron`.
2. **Clone it if missing.**

   ```bash
   gh repo clone lifinance/contracts-tron ../contracts-tron
   ln -s "$(git rev-parse --show-toplevel)/.env" ../contracts-tron/.env   # symlink, never copy — reuses this checkout's secrets
   ```

3. **Refuse a stale `.env`.** The fork must read this checkout's `.env` through a symlink; a copy goes stale silently (old keys, old `PRODUCTION`). Run from this checkout:

   ```bash
   [ "$(readlink <fork>/.env)" = "$(git rev-parse --show-toplevel)/.env" ] \
     || { echo "<fork>/.env is not a symlink to this checkout's .env — abort"; exit 1; }
   ```

   On failure, stop and ask the user to replace the file with the `ln -s` above; never overwrite it yourself.

4. **`cd` into it** for the rest of Phase 0 through Phase 4. All commands below assume the working directory is the `contracts-tron` checkout.

## Phase 0b — Preflight: branch, sync, delta

1. **Confirm you're in `contracts-tron`, not `contracts`, and on `main`.**

   ```bash
   git remote get-url origin | grep -q 'contracts-tron' || { echo "not in contracts-tron — abort"; exit 1; }
   git rev-parse --abbrev-ref HEAD   # must be main for a production deploy
   ```

2. **Fast-forward `main`, then check Foundry.** Stop if either fails:

   ```bash
   git pull --ff-only origin main
   bash script/utils/verify-foundry-version.sh
   ```

   A failed pull means local `main` diverged — report it, don't merge or reset. A version mismatch prints the fix (`foundryup --install <fork's .foundry-version>`); after the deploy, switch back with `foundryup --install "$(cat <this checkout>/.foundry-version)"` and re-run the checker in this checkout.

3. **Check the fork is synced for the contract you're about to deploy.** If upstream `contracts:main` has changes to `<Contract>` (or to `LibAsset`/`WithdrawablePeriphery`) not yet in the fork, stop and merge the pending `sync/upstream-YYYY-MM-DD` PR first (or open one) — do not deploy stale code. The scripts need the sync too: a fork whose Phase 3 `deploy-and-register-*.ts` script predates the ticket gate deploys without checking for a ticket and has no `--proposeOnly`:

   ```bash
   grep -q assertTicketPresent script/deploy/tron/<script>.ts || { echo "fork scripts predate the ticket gate — merge the upstream sync first"; exit 1; }
   ```

4. **Verify the `-tron` delta survived the last sync.** After any sync, confirm the bypass branch is still present:

   ```bash
   grep -q "TRON_USDT" src/Libraries/LibAsset.sol || { echo "Tron USDT bypass missing from LibAsset — sync broke the delta"; exit 1; }
   ```

   If missing, the sync merge dropped the fork's delta — resolve before deploying; do not deploy without the bypass on a chain where USDT is effectively all volume.

5. **Dry-run the deploy script** that Phase 3 will run, with the same `PRODUCTION` value. It prompts, so the user runs it (as `! <command>` in this session, or in their own terminal):

   ```bash
   cd <fork> && PRODUCTION=<true|false> bunx tsx script/deploy/tron/<script>.ts --dryRun
   ```

   For `deploy-and-register-periphery.ts`, add `--only <Contract>`: without it the script plans every periphery contract.

   It estimates the deploy's Energy and TRX cost and checks the deployer's balance net of delegated Energy, deploying and proposing nothing. When the contract is already recorded, answer **Yes** to "Redeploy? (DRY RUN - will simulate)": **No** skips the estimate. If it reports a shortfall, stop: fund the deployer or rent Energy, then re-run it.

## Phase 1 — Versioning gate

Audits are keyed by `ContractName` + `@custom:version`; one version must map to exactly one bytecode.

- Contract identical to the synced `main` baseline → same version (e.g. `2.1.3`).
- Contract differs in the fork → `<main-version>-tron` (e.g. `2.1.3-tron`).
- Redeploying against the same `main` baseline with further Tron-only changes → append a revision (`2.1.3-tron-r2`, `-r3`, ...).
- Never bump to `2.2.0-tron` unless `main` is actually at `2.2.0` and the fork has synced to that baseline.

Check the repo version before proceeding: `grep -m1 "@custom:version" src/Facets/<Contract>.sol` (or `src/Periphery/...`).

## Phase 2 — Confirm plan

Present: contract + version, the network and the `PRODUCTION` value that selects it (`tron` ⇔ `PRODUCTION=true`, `tronshasta` ⇔ `PRODUCTION=false`), which deploy scripts will run, and the Phase 0b dry-run cost against the deployer's TRX and Energy. Wait for explicit go-ahead — Tron deploys cost real TRX (Energy + Bandwidth), and production deploys go straight onto mainnet with no Safe-proposal buffer for the deploy step itself.

Before Phase 3, have the user supply the two values every proposal records, and export them in the shell that runs the scripts:

```bash
export SAFE_PROPOSAL_TICKET="EXSC-1234"            # mandatory: the Linear issue of this rollout
export SAFE_PROPOSAL_REASON="roll out EcoFacet v3.0.0 to tron (EXSC-1234)"   # shown to signers
```

The scripts refuse a run without the ticket before they build or spend TRX (`--dryRun` excepted). The reason is optional to the scripts, so ask for it: without one, signers see `Reason: — none given —`.

## Phase 3 — Run the contract's deploy-and-register script

**`PRODUCTION` alone picks the network and the key.** The scripts ignore `NETWORK`: `getEnvironment()` (`script/utils/utils.ts`) reads `PRODUCTION`, and `PRODUCTION=true` means `tron` with `PRIVATE_KEY_PRODUCTION` (deployerWallet), anything else means `tronshasta` with `PRIVATE_KEY` (devWallet). Both keys come from `.env`; an exported `PRODUCTION` wins over the `.env` value. Set it explicitly for every run, and check the network the script logs before it broadcasts:

```bash
export PRODUCTION=true    # tron (mainnet); PRODUCTION=false (tronshasta) only for scripts that support it

# the one for <Contract>:
bunx tsx script/deploy/tron/deploy-and-register-periphery.ts --only <Contract>
bunx tsx script/deploy/tron/deploy-and-register-symbiosis-facet.ts
bunx tsx script/deploy/tron/deploy-and-register-allbridge-facet.ts
bunx tsx script/deploy/tron/deploy-and-register-near-intents-facet.ts
bunx tsx script/deploy/tron/deploy-and-register-eco-facet.ts
bunx tsx script/deploy/tron/deploy-and-register-layerswap-facet.ts   # tron only: exits unless PRODUCTION=true
bunx tsx script/deploy/tron/deploy-and-register-lifi-intent-escrow-facet-v2.ts
```

Each script reads the network config, deploys via `TronContractDeployer` (CREATE-equivalent, not CREATE3 — Tron has no CREATE3 factory support here), estimates Energy/Bandwidth with the devkit's default safety margin, and updates `deployments/tron.json` / `deployments/tron.diamond.json` in the working tree.

**Never run `deploy-core-facets.ts` or `register-facets-to-diamond.ts` in a rollout.** They bootstrap a new diamond the deployer still owns: `register-facets-to-diamond.ts` sends `diamondCut` straight from the deployer, with no ticket and no Safe proposal. On a timelock-owned diamond the cut reverts after the Energy is spent; on one an EOA still owns it changes the diamond outside the multisig flow.

**Already deployed, only the proposal missing** (the propose step failed, or a Safe proposal was deleted): re-run the facet script with `--proposeOnly`. It skips the Redeploy prompt and the balance check, still shows the network confirmation, and proposes the address recorded for the network. It refuses when no address is recorded, when a `tronshasta` address would come from the `tron.json` fallback, and when the runtime code at the address doesn't match this checkout's artifact in `out/` (an older build left in the log, or no code). A failed read refuses with the RPC error; retry it rather than redeploying. Never answer the interactive "Redeploy?" prompt to get there — `Yes` starts another full deploy. Periphery uses `deploy-and-register-periphery.ts --registerOnly --only <Contract>` instead.

**The scripts build first.** They deploy the artifact in `out/` but label it with the source file's `@custom:version`, so every script that reads `out/` (the deploy scripts, `register-facets-to-diamond.ts` and `transfer-ownership-to-timelock.ts`) first runs `forge build --skip 'test/**'` with `FOUNDRY_*` overrides removed and `FOUNDRY_PROFILE=default` set, so `[profile.default]` applies even when `.env` names another profile. It then refuses unless every `src/` artifact records the default profile's solc version, EVM version and optimizer runs. A failed build or check stops the run before anything is broadcast.

**Keep the fork's `deployments/` across runs.** The scripts write `deployments/tron.json` / `tron.diamond.json` at deploy time and again at propose time. Resetting the fork's `deployments/` between runs of the same rollout (e.g. `git checkout -- deployments/`) drops those writes, so a later `deploy-and-register-periphery.ts --registerOnly` run reads the old address and reports "already correctly registered" without proposing the new one.

**Deployer wallet, not devWallet, on mainnet.** Production deploys run from `deployerWallet` (`config/global.json` → `tronWallets`); deployment Energy is rented from a rental service, not funded by delegation. Never hard-code the address; always read it from `global.json`, and check its TRX balance before Phase 3.

## Phase 4 — Verify on Tronscan

`forge verify-contract` cannot target Tron. This phase covers production deploys only: a `PRODUCTION=false` run logs to `deployments/<network>.staging.json`, while `verify-tron-contracts.ts` reads `deployments/<network>.json` and flags production records, so for a staging deploy it fails or verifies a stale production address. Skip it there and report the staging deploy as unverified. Run `verify-tron-contracts.ts` from the fork checkout, as in Phase 3: it reads `deployments/<network>.json` from the working directory, which is where Phase 3 wrote the new address, and `--repo-root .` flattens sources from the code that was deployed:

```bash
bunx tsx script/deploy/tron/verify-tron-contracts.ts --network <tron|tronshasta> --repo-root . --only <Contract>
```

It is the only Tron path that sets the MongoDB `verified` flag, so a manual Tronscan upload leaves the record unverified. A record that fails to flag ends the run non-zero; re-run that contract. Flags and the browser fallback: `docs/TronFork.md` → "Contract verification (Tronscan)".

## Phase 5 — Bring the deploy log to *upstream*, never the fork

**`tron` only.** A `tronshasta` run skips this phase: upstream tracks no `tronshasta` log (EXSC-818 removed it), so its `deployments/tronshasta.staging.json` stays in the fork.

The histories are unrelated enough that cherry-picking is the wrong tool — **copy the generated JSON as plain data** from the `contracts-tron` checkout into this `contracts` checkout. A deploy-log PR opened against `contracts-tron` → close it and re-open against upstream.

**Only `tron.json` moves now.** The scripts write `tron.diamond.json` in the fork as soon as the cut or periphery registration is proposed, but upstream it mirrors the loupe (`docs/DeploymentLogs.md`), so it changes only once the timelock op executes — `/finish-rollout` regenerates it then. Never copy the fork's `tron.diamond.json` upstream.

```bash
# capture the fork commit before leaving it — goes in the PR body for re-verification
# <fork> is the contracts-tron checkout Phase 0 located
TRON_COMMIT=$(git -C <fork> rev-parse HEAD)

# back in the contracts checkout (this repo), in the rollout's working tree
cp <fork>/deployments/tron.json deployments/tron.json
git diff deployments/tron.json   # only <Contract>'s entry should change
```

**Don't open a PR here.** `/multisig-rollout` Phase 5 stages `deployments/tron.json` with the EVM networks' logs and opens one draft PR for the whole rollout, the PR `/finish-rollout` later finishes. Hand back `$TRON_COMMIT` for its body: the fork commit flows into MongoDB via deploy-log ingestion and lets someone re-verify the bytecode later from that exact commit.

**Signing runs from this checkout, not the fork.** `confirm-safe-tx.ts` and `list-pending-proposals.ts` read the proposal store, not the fork's code, so `/multisig-rollout` Phases 4–8 run here in `lifinance/contracts`.

Once merged upstream, these logs reach `contracts-tron` again on the next upstream→fork sync PR — do not also commit them directly to the fork's `main`.

## Output

Report: contract + version, network(s), deployed address(es), Tronscan verification status, and, for `tron`, `$TRON_COMMIT` with `deployments/tron.json` copied into this checkout. Inside `/multisig-rollout`, hand these back and continue at its Phase 4.

## Failure modes

- No `contracts-tron` checkout and no `gh` access to clone one → stop and ask; never run the TronWeb steps from `contracts` — the `-tron` delta doesn't exist there.
- Insufficient deployer TRX (Phase 0b dry run) → stop before Phase 3; fund `tronWallets.deployerWallet` (or `devWallet` for `tronshasta`) or rent Energy first.
- Deployed, but the proposal failed (e.g. no ticket at propose time) → export the ticket and re-run with `--proposeOnly`; never redeploy.
- Logged network differs from the plan → stop before anything broadcasts; `PRODUCTION` is wrong for this run.

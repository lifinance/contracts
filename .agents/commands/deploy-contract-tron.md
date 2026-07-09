---
name: deploy-contract-tron
description: Deploys a facet/periphery contract to Tron (mainnet or Shasta testnet) from the `contracts-tron` fork — the two-repo, TronWeb-based round trip that Foundry's `deployContractToNetworks.sh` cannot run. Use whenever the target network is `tron`/`tronshasta`, whenever `deploy-contract` detects a Tron target and routes here, or when the user says "deploy <Contract> to tron", "redeploy on tron shasta", or "push the Tron USDT bypass fix". Locates or clones the `contracts-tron` checkout, checks the fork is synced with upstream `main` for the contract being deployed, verifies the `-tron` delta (LibAsset bypass + WithdrawablePeriphery re-route) is intact, enforces `-tron`/`-tron-rN` versioning, runs the TronWeb deploy scripts in order, verifies on Tronscan, and opens the deploy-log PR against **upstream** `lifinance/contracts` (never the fork). Requires `gh`, `bun`, and TRX in the deployer wallet (see Prerequisites). Background on why the fork exists and how sync works: `docs/TronFork.md`.
usage: /deploy-contract-tron <ContractName> <tron|tronshasta...>
---

# Deploy Contract to Tron

Tron has no Foundry support, so it does not go through `deployContractToNetworks.sh` or CREATE3 — it uses the TypeScript/TronWeb scripts in `script/deploy/tron/`, run from a **separate fork repo**, `lifinance/contracts-tron`. This skill is the Tron analog of `/deploy-contract`; use it whenever a target network is `tron` or `tronshasta`.

## Why a separate repo

`main` in `lifinance/contracts` carries **zero** Tron branching by design — Tron USDT is a broken ERC-20, so the fix (a bypass in `LibAsset.transferERC20` + a `WithdrawablePeriphery` re-route) lives only in the fork as a small, deliberate delta. Code flows one-way `contracts` → `contracts-tron`; deploy logs flow back the other way via a PR against upstream — never a direct commit to the fork. Full rationale, the exact fork delta, and the sync mechanism: **`docs/TronFork.md`** (read it if anything below is unclear on *why*, not just *what*).

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

```bash
export NETWORK=tron            # or tron-shasta for testnet
export PRIVATE_KEY=<64-char hex, no 0x>   # deployerWallet — see config/global.json tronWallets

bun script/deploy/tron/deploy-core-facets.ts
bun script/deploy/tron/register-facets-to-diamond.ts
# only the ones relevant to <Contract>'s type:
bun script/deploy/tron/deploy-and-register-periphery.ts
bun script/deploy/tron/deploy-and-register-symbiosis-facet.ts
bun script/deploy/tron/deploy-and-register-allbridge-facet.ts
bun script/deploy/tron/deploy-and-register-near-intents-facet.ts
bun script/deploy/tron/deploy-and-register-eco-facet.ts
```

Each script reads the network config, deploys via `TronContractDeployer` (CREATE-equivalent, not CREATE3 — Tron has no CREATE3 factory support here), estimates Energy/Bandwidth with a safety margin, and updates `deployments/tron.json` / `deployments/tron.diamond.json` in the working tree.

**Deployer wallet, not devWallet.** Deploys run from `deployerWallet` (`config/global.json` → `tronWallets`); deployment Energy is rented from a rental service, not funded by delegation — see Prerequisites. Never hard-code the address; always read it from `global.json`.

## Phase 4 — Verify on Tronscan

Foundry's `forge verify` does not support Tron. Verify manually:

1. `forge flatten src/<Facets|Periphery>/<Contract>.sol > /tmp/<Contract>-flat.sol`
2. On the relevant explorer (mainnet `https://tronscan.org`, testnet `https://shasta.tronscan.org`), open the deployed address → **Contract** tab → **Verify and Publish**.
3. Select the compiler version from `foundry.toml`, paste the flattened source, and supply ABI-encoded constructor args.

Tronscan API (for scripted checks): mainnet `https://apilist.tronscan.org/api`, testnet `https://api.shasta.tronscan.org/api`.

## Phase 5 — PR the deploy logs to *upstream*, never the fork

This is the step most likely to be gotten backwards. The fork never pushes back to `main` — deploy logs are the one exception, and even they don't go to the fork's own PR flow. `contracts-tron` and `contracts` are separate repos with unrelated-enough histories that cherry-picking commits between them is the wrong tool — **copy the two generated JSON files as plain data**, from the `contracts-tron` checkout into a fresh branch of `contracts`.

```bash
# capture the fork commit before leaving it — goes in the PR body for re-verification
TRON_COMMIT=$(git -C ../contracts-tron rev-parse HEAD)

# back in the contracts checkout (this repo)
git checkout -b deploy-tron-<contract>-<date> origin/main
cp ../contracts-tron/deployments/tron.json deployments/tron.json
cp ../contracts-tron/deployments/tron.diamond.json deployments/tron.diamond.json

git add deployments/tron.json deployments/tron.diamond.json
git commit -m "chore(<Contract>): deploy vX.Y.Z-tron to tron"
git push -u origin HEAD

gh pr create --repo lifinance/contracts \
  --title "chore(<Contract>): deploy vX.Y.Z-tron to tron" \
  --body "Deploy log update from contracts-tron. Commit: $TRON_COMMIT"
```

Store the `contracts-tron` commit hash in the PR body (and it flows into MongoDB via the normal deploy-log ingestion) — this is what lets someone re-verify bytecode later by checking out that exact fork commit, without upstream `main` needing to still match. Run this PR through the normal `/pr-ready` gate before opening it, same as any other deploy-log PR.

Once merged upstream, these logs reach `contracts-tron` again on the next upstream→fork sync PR — do not also commit them directly to the fork's `main`.

## Output

Report: contract + version, network(s), deployed address(es), Tronscan verification status, and the upstream PR URL (or explicit note that Phase 5 is still pending and who owns it).

## Failure modes

- Wrong repo (`contracts` instead of `contracts-tron`) → abort immediately; nothing in this skill's Phase 0b–4 runs against upstream. Only Phase 5 runs from `contracts`.
- No `contracts-tron` checkout found and no `gh` access to clone one → stop and ask; do not attempt the TronWeb steps from the `contracts` checkout, the fork's `-tron` delta doesn't exist there.
- Fork out of sync with `main` for the target contract → stop and route to the pending/needed `sync/upstream-*` PR first; do not deploy stale bytecode.
- `-tron` delta missing after a sync (grep in Phase 0 step 3 fails) → the sync merge dropped Tron-specific code; fix before deploying, especially for any contract that moves USDT.
- Version doesn't follow the `-tron`/`-tron-rN` scheme, or implies a `main` version that doesn't exist yet → fix before deploying; audit tooling assumes one version = one bytecode.
- Deploy log PR opened against `contracts-tron` instead of `lifinance/contracts` → close it and re-open against upstream; the fork must never receive a direct commit for deploy logs.
- Insufficient deployer TRX → see `deployer-wallet-address-vs-global-json` guidance: derive the deployer address from the private key, not `global.json`, and check its TRX balance before running Phase 3.

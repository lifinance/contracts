---
name: deploy-network
description: Brings a brand-new network fully on-chain by driving `deployAllContracts.sh` (scriptMaster use case 3) end to end — CREATE3 factory, core facets, diamond, non-core facets, periphery, whitelist sync, wallet funding, and health check — one stage at a time so it survives an agent's per-command time limit and needs no interactive terminal. Use after `add-network` has landed the config (networks.json, foundry.toml, target state) and the deployer is funded, when the user wants to "deploy the new network", "bring up <network> on-chain", "run the full deployment for <network>", or "deploy all contracts to <network>". This is the NEW-NETWORK bootstrap path and it runs production in direct-to-diamond mode (`SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true`) because the Safe/timelock does not own the diamond yet. It stops after stage 11 (health check) and never performs stage 12 (ownership transfer) — that stays a deliberate step. NOT for deploying a single contract to existing networks (use `deploy-contract`), NOT for upgrading facets on networks that are already live and Safe-owned (use `multisig-rollout`), and NOT for Tron (`tron`/`tronshasta` — Foundry has no Tron support; there is no new-network bootstrap path there yet). Requires Foundry, gh, initialized submodules, and `MONGODB_URI` in `.env`.
usage: /deploy-network <network> --production [--from-stage N] [--to-stage M]
---

# Deploy Network (LI.FI Contracts)

Drives a full new-network bring-up via the `deployAllContracts` function
(`script/deploy/deployAllContracts.sh`, scriptMaster use case 3), **one stage per fresh
shell**. Each of the 12 stages is idempotent (CREATE3 → deterministic addresses, plus
`diamondCut`), so a stage that is interrupted or re-run resumes instead of duplicating work.
This lets an agent complete a deploy that runs far longer than a single command's time budget,
and with no TTY, by invoking the script once per stage with the stage range and non-interactive
mode preset in the environment.

## When to use this vs other deploy skills

| Situation | Skill |
|---|---|
| Config for a new network (networks.json, foundry.toml, target state) | **`add-network`** (run first) |
| Bring a **new** network fully on-chain (diamond + all contracts) | **this skill** |
| Deploy/redeploy a **single** contract to existing network(s) | **`deploy-contract`** |
| Upgrade facets/periphery on **existing, Safe-owned** networks | **`multisig-rollout`** |
| Ownership transfer / post-rollout completion | done deliberately (`finish-rollout` / stage 12) |

## Hard rails

- **New-network bootstrap only.** This path sets `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true`,
  which bypasses the Safe. That is legitimate *only* before the diamond's ownership has been
  transferred to the Safe/timelock. If the network is already Safe-owned, stop — use
  `multisig-rollout`.
- **Never runs stage 12 (ownership transfer).** The driver bounds the run to stage 11. Ownership
  transfer is a deliberate, reviewed step performed after inspecting the health check.
- **Never edits `.env` silently.** The production flags (`PRODUCTION=true`,
  `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true`) are shared, symlinked state — set them with the
  user's explicit go, announce it, and restore afterward.
- **Tron is out of scope.** No Foundry/CREATE3 support; there is no bootstrap path for
  `tron`/`tronshasta` here.

## Phase 0 — Preflight (report, don't silently fix)

Run from the target network's worktree. Confirm:

- `add-network` config for the network is present (entry in `config/networks.json`, in
  `foundry.toml`, and in `script/deploy/_targetState.json`).
- `lib/` submodules initialized and `forge clean && forge build` is fresh (CREATE3 salt derives
  from `out/`).
- Deployer wallet funded on the network (stage 1 aborts on zero balance; the pauser/dev wallets
  are funded automatically at stage 9 from the deployer).
- `MONGODB_URI` set in `.env` (stage 1 auto-adds the RPC from `networks.json` → MongoDB →
  `fetch-rpcs`; no premium RPC required).
- For production: `PRODUCTION=true` and `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true` (set with the
  user's go; see hard rails).

## The stages

| # | Stage |
|---|---|
| 1 | Initial setup + CREATE3Factory (+ Safe deploy on production) |
| 2 | Deploy core facets |
| 3 | Deploy diamond + add core facets |
| 4 | Approve refund wallet |
| 5 | Deploy non-core facets + add to diamond *(heavy — may exceed one command's budget)* |
| 6 | Deploy periphery contracts |
| 7 | Add periphery to diamond |
| 8 | Whitelist sync |
| 9 | Fund PauserWallet + DevWallet |
| 10 | Verify ERC20Proxy (Executor) authorization |
| 11 | Health check |
| 12 | Ownership transfer — **skipped by this skill** |

## Phase 1 — Drive the stages

`deployAllContracts` reads three environment overrides (added for this skill; unset preserves the
original interactive behavior):

- `START_STAGE` / `END_STAGE` — bound the run to `[START_STAGE, END_STAGE]` and skip the
  interactive `gum` stage menu.
- `NON_INTERACTIVE=true` — accept computed defaults at the stage-9 funding prompts and
  auto-confirm the stage-10 ERC20Proxy owner-funding prompt (in
  `script/tasks/verifyERC20ProxyAuthorization.sh`).

Run **each stage as its own command** (fresh shell, stays under the time limit):

```bash
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"
cd <network-worktree>
START_STAGE=<N> END_STAGE=<N> NON_INTERACTIVE=true \
  bash -c 'source script/deploy/deployAllContracts.sh; deployAllContracts <network> production'
```

After each stage, confirm the log contains `STAGE <N> completed` before advancing:

- **Marker present** → advance to stage N+1.
- **Marker absent** (timed out / interrupted) → re-run the *same* stage. Idempotency means it
  resumes; the heavy stage 5 typically needs a few re-runs to deploy all facets. Cap at ~5
  re-runs per stage — if a stage still never completes, stop and surface the failure with the
  log; do not loop indefinitely.

Advance 1 → 11. The run auto-stops after stage 11 (`END_STAGE < 12`), leaving the deployer as
diamond owner — the correct, resumable pre-ownership-transfer state.

## Phase 2 — Land the results

- **Commit the deploy artifacts** (`deployments/<network>.json`, diamond log files) to the
  network's `add-network` PR — this is what turns the `check-new-network-health` CI gate green.
- **Restore `.env`** if production flags were set for the run (`PRODUCTION=false`,
  `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=` empty).
- **Verify** contracts on the explorer and re-check the PR checks.
- **Executor authorization follow-up:** if `ERC20Proxy < 1.2.0`, stage 10 only funds the owner
  (refundWallet) — the actual `setAuthorizedCaller(Executor, true)` is a manual owner-key tx.
  Surface it; swaps routed through the Executor fail until it lands.

## Hand-offs

- **Ownership transfer** (stage 12) → deliberate step / `finish-rollout` once the health check is
  clean (only diamond-ownership errors remain).
- **Bridge integrations** (Stargate, Across, etc.) → their own follow-up deploys after bring-up.

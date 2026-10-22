---
name: rotate-deployer-wallet
description: "Rotates the shared SC-owned **Deployer** wallet — `safeOwners[0]` + the Timelock `CANCELLER_ROLE` — end-to-end: bootstraps the new deployer's gas, swaps the Safe owner and moves the canceller role via Safe proposals (`manageSafeOwner` / `manageTimelockCanceller`), handles Tron, updates config, decommissions the old key, and gates on a completeness check. Orchestrates `sweep-wallet-funds`, `move-tron-delegation`, `update-wallet-config` and `check-rotation-status` without reimplementing them. Use when the user says \"rotate the deployer wallet\", \"replace safeOwners[0]\", \"swap the deployer / canceller EOA\", or \"/rotate-deployer-wallet\". NOT for the staging owner (`rotate-dev-wallet`), the emergency pauser (`rotate-pauser-wallet`) or a full offboarding (`offboard-sc-dev`). Requires Foundry, gh, lifi-connect for MongoDB, and a securely generated new wallet + hardware-wallet signing — both human steps. Never self-signs."
usage: /rotate-deployer-wallet [--new-address 0xNEW] [--check]
---

# Rotate Deployer Wallet (LI.FI Contracts)

## Purpose

Rotate the shared **Deployer** wallet, which carries the protocol's heaviest privileges:

- `safeOwners[0]` — a signer on every production Safe.
- The Timelock `CANCELLER_ROLE`.
- The CREATE3 deployer key used to broadcast deploys.

Because it is SC-owned it is rotatable, but every privilege it holds is governed by Safe + Timelock — so the on-chain swaps run as **Safe proposals** (Phase 2), never as owner shortcuts. This skill is a **thin orchestrator**: it sequences the L1 and existing skills, enforces the guardrails, and gates on the final check. It reimplements none of their logic.

## When to use / when NOT

Use when the user says:

- "rotate the deployer wallet" / "replace safeOwners[0]" / "swap the deployer / canceller EOA"
- "/rotate-deployer-wallet [0xNEW]"

Do NOT use for:

- The staging **Dev** wallet (staging diamond owner) → `rotate-dev-wallet`.
- The **Pauser** emergency EOA → `rotate-pauser-wallet`.
- A full SC-dev **offboarding** (signer swap + all three rotations + secret rotation) → `offboard-sc-dev` (the orchestrator that calls this skill).
- Any **CTO-owned** wallet (refund / feeCollector / withdraw) — see Guardrails.

## Inputs

Required:

- **--new-address** — the securely generated new deployer EOA (`0x…`). If not supplied, ask once; never generate it inside the skill (see Guardrails).

Optional:

- **--check** — run the completeness check only (delegates to `check-rotation-status`, changes nothing) and stop. Use to preview state before rotating or to re-verify after.

The **old** deployer address is derived from `PRIVATE_KEY_PRODUCTION` in `.env` (the sweep in Phase 1 does this), never from `config/global.json.deployerWallet` — the key and the config can diverge, and the wrong address makes a funded wallet look empty (or a rotation look incomplete).

## Guardrails

- **Custody guard.** Rotate only SC-owned wallets (**deployer, dev, pauser**); this skill rotates **deployer** only. NEVER touch the CTO-owned refund / feeCollector / withdraw — if the request drifts there, stop and say so.
- **Never self-sign.** New-key generation is a human step. The Safe owner swap and canceller-role move are Ledger-signed by the human (`script/deploy/safe/confirm-safe-tx.ts`); this orchestrator hands off and WAITS — it never runs the signer.
- **Never bypass Safe/timelock** (rule 002-architecture). Every EVM Safe owner change is a Safe proposal and every role/canceller change a timelock-wrapped one (Phase 2). The Tron ownership transfer (Phase 3, `transfer-ownership-to-timelock.ts`) is the one different mechanism but still governed — its confirm step is itself a Safe/Timelock proposal, not an owner shortcut.
- **Secrets hygiene.** Never print a private key or full RPC URL; read keys in a subshell and redact. Derive the acting address from the key, never from `config/global.json`.
- **Bootstrap ordering.** Sweep FIRST (Phase 1) so the new deployer has gas before it acts; within the sweep, native goes LAST (the L1 skill enforces this) so gas for other moves isn't stranded.
- **Dry-run first.** Run each step's preview/`--check`/`--dryRun` and confirm the plan before any broadcast or proposal is minted.

## Workflow

Foundry/bun may need `export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"`. lifi-connect is required for the MongoDB signature verification in Phase 2.

### Phase 0 — Preflight & confirm plan

- Confirm `--new-address` is present, checksum-valid, and NOT any current SC/CTO wallet in `config/global.json`.
- Report old → new for the EVM field and the derived Tron base58.
- Present the ordered plan (Phases 1–7) and wait for explicit go-ahead. State up front that the rotation is **semi-automated**: it will pause for human key generation and, critically, for **Ledger signing** of the Phase 2 Safe proposals, after which the user returns to the chat and the skill resumes with the remaining phases (3–7).

### Phase 1 — Bootstrap the new deployer's gas (`sweep-wallet-funds`) — FIRST

Sweep native gas from the old deployer to the new one across all active EVM chains so the new deployer can broadcast. This runs **before** any governance change so the new wallet is fundable and usable when the Safe adds it.

```text
/sweep-wallet-funds --new-address <NEW> --old-key-env PRIVATE_KEY_PRODUCTION --production
```

`sweep-wallet-funds` previews balances first, sweeps native LAST (stranding guard), and owns the human-confirmed pre-send report + secrets hygiene. Do not reimplement `moveNativeFundsToNewWallet.ts` here.

> Leave enough in the OLD deployer to sign the Safe/timelock txs it still needs to send in Phase 2 if any are broadcast by the old key — `sweep-wallet-funds`'s balance preview (read-only; the mover script has no dry-run flag) lets you judge this per network before committing.

> **HyperEVM big blocks (manual, per-address).** The new deployer cannot broadcast contract deploys on `hyperevm` until big blocks are enabled for it — an L1 setting that does **not** carry over on rotation (register the address as a HyperCore Core user, then toggle big blocks ON). Follow the runbook: `docs/HyperEVMBigBlocks.md`.

> **Sophon deployer allow-list (manual, per-address).** `sophon` gates contract deployment behind a per-EOA allow-list, so the new deployer is **rejected on every Sophon deploy** (`contract deployer address … is not in the allow list`) until the Sophon team adds it — funding the wallet is not enough, and the allow-listing does **not** carry over on rotation. It's an off-repo, async request, so start it **now** during bootstrap rather than discovering it at the next Sophon rollout: ask in the Sophon partner channel to allow-list the new deployer EOA. It doesn't block the other phases. (Other zkEVM chains like `abstract` and `zksync` have no such restriction.)

### Phase 2 — Swap the Safe owner + move CANCELLER_ROLE

`multisig-rollout` has no owner-swap mode; it deploys, proposes cuts and syncs whitelists only. The proposals come from two helpers in `script/playgroundHelpers.sh`, run once per production network:

- `manageSafeOwner "replace" <network> <OLD> <NEW>` — a Safe `swapOwner` proposal on the Safe itself (not timelock-wrapped).
- `manageTimelockCanceller "replace" <network> <OLD> <NEW>` — a timelock-wrapped proposal that revokes `CANCELLER_ROLE` from the old deployer and grants it to the new one.

No committed entry point runs these across networks; the commented examples in `executeNetworkActions` (`script/multiNetworkExecution.sh`) are the team's playground for it. Ask the user how they want to run them, and do not commit the playground edit. Then follow `multisig-rollout`'s tail for the created proposals: hand Ledger signing to the human (`confirm-safe-tx.ts`), verify `signatureCount >= 2` in MongoDB, and post `#dev-sc-multisig-proposals`. Never self-sign, never bypass the Safe.

### Phase 3 — Tron: Safe owner + delegation

Read the Tron diamond's owner first:

```bash
bunx tsx script/troncast/index.ts call --env mainnet <LiFiDiamond from deployments/tron.json> "owner() returns (address)"
```

If it is the `LiFiTimelockController` from `deployments/tron.json`, there is no ownership to move and `transfer-ownership-to-timelock.ts` has nothing to do; if it is the old deployer, run that script (`--dryRun`, then `--step 1`, then `--step 2`, with `PRODUCTION=true`). The Tron Safe owner swap has no helper — `manageSafeOwner` proposes through the EVM `propose-to-safe.ts` — so report it as a manual follow-up rather than marking Tron done.

Then re-point the Tron staked-resource delegation from the old deployer Tron address to the new one:

```text
/move-tron-delegation --old-address <old deployer 0x…> --new-address <NEW> --role deployer
```

`move-tron-delegation` derives both base58 addresses, drafts the undelegate→re-delegate request (delegator-controlled, executed off-repo), and verifies on Tronscan afterward. Any Ledger signing the Tron ownership step needs is a human step.

### Phase 4 — Update config (`update-wallet-config`)

Open the PR that rotates the `deployerWallet` role in config.

```text
/update-wallet-config --role deployer --new-address <NEW> --production
```

`update-wallet-config` updates the EVM `deployerWallet` field AND `tronWallets.deployerWallet` (Tron base58 derived + reverse-checked), honors config-structure rule 004, and ends by calling `/create-pr`. Notion registry update is a flagged follow-up.

### Phase 5 — Decommission the old key

Once Phases 2–4 have landed and `check-rotation-status` (Phase 6) confirms the old address holds no Safe-owner / canceller / owner privileges anywhere, the old private key can be retired: remove it from `.env` / secret stores and rotate any CI secret that carried it. This is a human/operational step — surface the exact checklist; do not attempt to touch secret stores from the skill.

### Phase 6 — Verify (`check-rotation-status`)

Run the read-only completeness gate scoped to the deployer rotation:

```text
/check-rotation-status --old-address <old deployer 0x…> --new-address <NEW> --role deployer --production
```

For the deployer role the relevant checks are: Safe-owner membership (old removed / new added) on every production Safe, Timelock `CANCELLER_ROLE` (old removed / new granted), and the CI wallet-funding check. `check-rotation-status` covers EVM only; Tron counts as done only on Phase 3's owner read and Tronscan delegation evidence. Only declare complete when every network passes.

### Phase 7 — Report

Summarize: swept networks (moved/skipped), the Phase 2 outcome (proposal nonces, Slack thread, remaining team signatures), Tron ownership + delegation state, config PR URL, old-key decommission status, and the `check-rotation-status` result. Call out anything still pending (unsigned proposals, unverified networks) and the human follow-ups.

## Verification

Complete only when `check-rotation-status` (Phase 6) passes for every network: new deployer is `safeOwners[0]` and holds `CANCELLER_ROLE`, the old deployer holds neither anywhere, and funding passes — plus Phase 3's Tron evidence. The Safe owner swap lands once its proposal is signed to threshold and executed; the canceller change is timelock-wrapped, so it lands only after the timelock delay as well. Until then the check may legitimately still show "old"; report that as pending, not as failure. Re-run `/rotate-deployer-wallet --new-address <NEW> --check` to re-confirm.

## Reuse map

| Step | Delegates to | Owns |
|---|---|---|
| Bootstrap gas | `sweep-wallet-funds` | native sweep across EVM chains, pre-send report, secrets hygiene |
| Safe owner swap + canceller move | `manageSafeOwner` / `manageTimelockCanceller` (`script/playgroundHelpers.sh`), then `multisig-rollout`'s signing tail | proposals → Ledger hand-off → Mongo sig verify → Slack |
| Tron ownership → Timelock (only if still deployer-owned) | `script/deploy/tron/transfer-ownership-to-timelock.ts` | env-derived Tron handover (`PRODUCTION=true` → tron) |
| Tron delegation | `move-tron-delegation` | undelegate→re-delegate request + Tronscan verify |
| Config PR | `update-wallet-config` | `global.json` deployerWallet + `tronWallets.deployerWallet`, `/create-pr` |
| Completeness gate | `check-rotation-status` | read-only cross-network verification |

This skill adds only sequencing (sweep-first bootstrap ordering), the custody/self-sign/no-bypass guardrails, and the confirm gate — no funds-moving, signing, address-deriving, or config-editing logic of its own.

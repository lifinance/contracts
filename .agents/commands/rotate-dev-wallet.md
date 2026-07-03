---
name: rotate-dev-wallet
description: Rotates the shared SC-owned **Dev** wallet (the staging LiFiDiamond owner) end-to-end — funds the new wallet, transfers staging diamond ownership old→new, moves the Tron energy delegation, updates config, and gates on a completeness check. Thin orchestrator: it CALLS the L1 skills (`sweep-wallet-funds`, `move-tron-delegation`, `update-wallet-config`, `check-rotation-status`) and existing skills, never reimplements them. Use when the user says "rotate the dev wallet", "replace the staging owner wallet", "swap the shared dev EOA", or "/rotate-dev-wallet". This is the lowest-stakes (staging-only) rotation and the reference for the heavier siblings — NOT for the production Safe-owner deployer (that is `rotate-deployer-wallet`), NOT for the emergency pauser (that is `rotate-pauser-wallet`), and NOT for a full person offboarding (that is `offboard-sc-dev`). Requires Foundry, gh, and a securely generated new wallet (a human step). Secure key generation and any Ledger signing are human steps — never self-sign.
usage: /rotate-dev-wallet [--new-address 0xNEW] [--check]
---

# Rotate Dev Wallet (LI.FI Contracts)

## Purpose

Rotate the shared **Dev** wallet — the EOA that owns each network's **staging** LiFiDiamond (`config/global.json.devWallet` + `tronWallets.devWallet`). Because it is SC-owned it is rotatable; because it governs only staging it is the lowest-stakes of the rotations and the reference implementation the heavier siblings mirror.

This skill is a **thin orchestrator**. Every moving part is owned by an L1 skill or an existing skill; this file only sequences them, enforces the guardrails, and gates on the final check. It reimplements none of their logic.

## When to use / when NOT

Use when the user says:

- "rotate the dev wallet" / "replace the staging owner wallet" / "swap the shared dev EOA"
- "/rotate-dev-wallet [0xNEW]"

Do NOT use for:

- The production **Deployer** = `safeOwners[0]` + Timelock `CANCELLER_ROLE` → `rotate-deployer-wallet` (governance-heavy, Safe proposals).
- The **Pauser** emergency-pause EOA → `rotate-pauser-wallet` (immutable `pauserWallet`, needs a facet redeploy).
- A full SC-dev **offboarding** (signer swap + all three wallet rotations + secret rotation) → `offboard-sc-dev` (the orchestrator that calls this skill).
- Any **CTO-owned** wallet (refund / feeCollector / withdraw) — see Guardrails.

## Inputs

Required:

- **--new-address** — the securely generated new dev EOA (`0x…`). If not supplied, ask once; never generate it inside the skill (see Guardrails).

Optional:

- **--check** — run the completeness check only (delegates straight to `check-rotation-status`, changes nothing) and stop. Use to preview state before rotating or to re-verify after.

The **old** dev address is derived from `config/global.json.devWallet` for reference, but every funds/ownership step derives the acting sender from the private key in `.env`, never from `global.json` (which can be mid-rotation-inconsistent).

## Guardrails

- **Custody guard.** Only the SC-owned wallets may be rotated: **deployer, dev, pauser**. This skill rotates **dev** only. NEVER touch refund / feeCollector / withdraw — those are CTO-owned. If the request drifts to a CTO wallet, stop and say so.
- **Never self-sign.** Secure key generation for the new wallet is a human step — never generate or derive a fresh private key here. Any Ledger signing that arises (e.g. a Tron ownership-to-Timelock step) is handed to the human via the owning skill; this orchestrator never signs.
- **Never bypass Safe/timelock** (rule 002-architecture governance). Staging diamonds are EOA-owned, so the staging ownership transfer is a direct owner tx — but any governed on-chain change routes through `multisig-rollout`; this skill never crafts owner shortcuts around governance.
- **Secrets hygiene.** Never print a private key or a full RPC URL; read keys in a subshell and redact. Derive the acting address from the key, never from `config/global.json`.
- **Dry-run first.** Each L1 step below has its own preview/`--check`; run the previews before the state-changing pass, and confirm the plan with the user before broadcasting anything.

## Workflow

Foundry/bun may need `export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"`.

### Phase 0 — Preflight & confirm plan

- Confirm `--new-address` is present, checksum-valid, and NOT any current SC/CTO wallet in `config/global.json` (a no-op or a self-collision is a mistake).
- Report old → new for both the EVM field and the derived Tron base58 (the derivation itself is done inside `update-wallet-config` / `move-tron-delegation`).
- Present the ordered plan (Phases 1–6) and wait for explicit go-ahead. State up front that the rotation is **semi-automated**: it will pause for the human key-generation confirmation and, on Tron, for any Ledger signing.

### Phase 1 — Fund the new wallet (`sweep-wallet-funds`)

Sweep native gas from the old dev wallet to the new one across all active EVM chains, so the new wallet can pay for its own ownership-acceptance / delegation txs.

```text
/sweep-wallet-funds --new-address <NEW> --old-key-env PRIVATE_KEY   # staging dev key
```

`sweep-wallet-funds` previews balances first (dry-run), sweeps native **LAST** to avoid stranding gas, and reports per-network moved/skipped. It owns the human-confirmed pre-send report and secrets hygiene — do not reimplement `cast send` or `moveNativeFundsToNewWallet.ts` here.

### Phase 2 — Transfer staging diamond ownership (old → new)

Staging diamonds are EOA-owned by the dev wallet, so this is a direct owner transfer per EVM network (the old dev key sets the new dev address as owner; the new wallet accepts if the diamond uses a two-step handover). Run the preview/dry-run first, confirm, then execute one network at a time.

On **Tron staging** (`tronshasta`) ownership does not go to an EOA — hand the diamond to the Timelock via the existing script (env-derived network: staging → `tronshasta`, NOT a flag):

```bash
bunx tsx script/deploy/tron/transfer-ownership-to-timelock.ts --dryRun            # preview
bunx tsx script/deploy/tron/transfer-ownership-to-timelock.ts --step 1            # then --step 2
```

This script may prompt for `--currentOwnerPrivateKey`; supply the old dev key via env, never inline. If any step needs Ledger signing, it is a human step — never self-sign.

### Phase 3 — Move Tron energy delegation (`move-tron-delegation`)

Re-point the Tron staked-resource (energy/bandwidth) delegation from the old dev Tron address to the new one. There is no repo tooling and the delegation is delegator-controlled, so this is executed off-repo by the resource-provider wallet holder.

```text
/move-tron-delegation --old-address <old dev 0x…> --new-address <NEW> --role dev
```

`move-tron-delegation` derives both Tron base58 addresses, drafts the undelegate→re-delegate request, and after execution VERIFIES on Tronscan (new address shows the energy, old shows 0). Do not derive addresses or draft the request here.

### Phase 4 — Update config (`update-wallet-config`)

Open the PR that rotates the `devWallet` role in config.

```text
/update-wallet-config --role dev --new-address <NEW>
```

`update-wallet-config` updates the EVM `devWallet` field AND the matching `tronWallets.dev` (Tron base58 derived via `troncast address to-base58`, cross-checked with the reverse `to-hex`), honors config-structure rule 004, and ends by calling `/create-pr`. The Notion registry update is a follow-up it flags (needs auth — don't fake it).

### Phase 5 — Verify (`check-rotation-status`)

Run the read-only completeness gate scoped to the dev rotation:

```text
/check-rotation-status --old-address <old dev 0x…> --new-address <NEW> --role dev
```

For the dev role the relevant checks are: staging-diamond `owner()` = new (old no longer owner) on every EVM network, the Tron staging owner/delegation state, and the CI wallet-funding check. Only declare the rotation complete when every network passes.

### Phase 6 — Report

Summarize per network: swept (moved/skipped), staging ownership transferred, Tron delegation moved + verified, config PR URL, and the `check-rotation-status` result. Call out any network still failing the check and the remaining human follow-ups (Notion registry update, decommissioning the old dev key).

## Verification

The rotation is complete only when `check-rotation-status` (Phase 5) passes for every active network: new dev owns each staging diamond, old dev owns none, Tron staging + delegation reflect the new address, and funding passes. Re-run `/rotate-dev-wallet --check` any time to re-confirm without changing state.

## Reuse map

| Step | Delegates to | Owns |
|---|---|---|
| Fund new wallet | `sweep-wallet-funds` | native sweep across EVM chains, pre-send report, secrets hygiene |
| Tron ownership → Timelock | `script/deploy/tron/transfer-ownership-to-timelock.ts` | env-derived Tron network handover (staging → tronshasta) |
| Tron delegation | `move-tron-delegation` | undelegate→re-delegate request + Tronscan verify |
| Config PR | `update-wallet-config` | `global.json` devWallet + `tronWallets.dev`, `/create-pr` |
| Completeness gate | `check-rotation-status` | read-only cross-network verification |

This skill adds only sequencing, the custody/self-sign guardrails, and the confirm-before-broadcast gate — no funds-moving, address-deriving, or config-editing logic of its own.

---
name: move-tron-delegation
description: "Moves Tron energy/bandwidth delegation from a rotated-out wallet's Tron address to the new one: derives base58 addresses, drafts the request for the off-repo provider, verifies on Tronscan. Signs nothing. Use for \"move the tron energy delegation\". Tron diamond owner → `rotate-deployer-wallet`."
usage: /move-tron-delegation --old-address 0xOLD --new-address 0xNEW [--role dev|deployer] [--resources energy|bandwidth|both]
---

# Move Tron Delegation

The rotated-out dev/deployer wallet's Tron address receives staked-resource delegation (energy, sometimes bandwidth) from a separate resource-provider wallet; without it the new wallet burns TRX per transaction. Delegation is delegator-controlled: the undelegate/re-delegate is executed off-repo by the provider (Max), never from our keys — do not attempt `troncast send` or any broadcast for it. This skill derives addresses, drafts the request, and verifies. Background ticket: EXSC-562.

Delegation ≠ ownership: moving the Tron LiFiDiamond `owner()` is `script/deploy/tron/transfer-ownership-to-timelock.ts`, owned by `rotate-deployer-wallet`.

## Inputs

- `--old-address`, `--new-address` (required) — EVM `0x…` of the rotated-out and new wallet. Take the old one from the key or the user, never from `config/global.json` (can be mid-rotation-inconsistent).
- `--role` — `dev` | `deployer`, for the request text and the config follow-up. Ask once if unclear.
- `--resources` — default energy; confirm the real delegation on Tronscan (Step 2).

Custody guard: never move delegation tied to refund / feeCollector / withdraw (CTO-owned).

## Workflow

### 1. Derive both Tron base58 addresses

`troncast address` is offline but aborts without `ETH_NODE_URI_TRON`, so prefix a dummy URL. Subcommands are kebab-case, address positional, comma-separate for several.

```bash
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"

OLD_EVM="<oldWalletEvmAddress>"
NEW_EVM="<newWalletEvmAddress>"

OLD_TRON=$(ETH_NODE_URI_TRON="https://dummy" bun troncast address to-base58 "$OLD_EVM")
NEW_TRON=$(ETH_NODE_URI_TRON="https://dummy" bun troncast address to-base58 "$NEW_EVM")

# reverse-check: to-hex of each base58 must return the original EVM address
ETH_NODE_URI_TRON="https://dummy" bun troncast address to-hex "$OLD_TRON,$NEW_TRON"
```

If the reverse check fails for either, stop. Show the old/new EVM = base58 pair before drafting.

### 2. Read the current delegation on the old address

`https://tronscan.org/#/address/<OLD_TRON>` → **Resources**: record delegator address, resource type(s), and amount delegated in. Nothing delegated → nothing to move; report and stop.

### 3. Draft the request for the provider

```text
Tron resource delegation move (rotation EXSC-<ticket>, role: <dev|deployer>)

Please move the staked-resource delegation from our old wallet to the new one:

  UNDELEGATE  ~<N> <energy|bandwidth>  FROM  <OLD_TRON>
  RE-DELEGATE the same               TO    <NEW_TRON>

Delegator wallet (yours): <delegator T-address from Step 2>
This is delegatee-side only; we cannot execute it from our keys.
Ping here once done and I'll verify on Tronscan.
```

Hand it to the user to relay; don't send it anywhere unless asked.

### 4. Wait for the provider

Do not proceed or mark the Tron step done until the provider confirms and Step 5 passes.

### 5. Verify on Tronscan

- `<NEW_TRON>` → Resources shows the expected delegation from the provider.
- `<OLD_TRON>` → Resources shows 0 of it remaining.

Both must hold; a residual on the old address means the undelegate half is incomplete — re-request.

### 6. Config

If the rotation's `update-wallet-config` PR (`tronWallets.<role>`) has not landed, run `/update-wallet-config` for this role now.

## Verification

Report the base58 pair (reverse check passed), the delegator/type/amount observed, the Tronscan evidence for both sides, and whether `tronWallets.<role>` is updated or its PR pending. If any is missing, the Tron delegation step is not complete. `check-rotation-status` does not cover this.

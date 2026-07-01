# Staging Wallet Rotation

Runbook for replacing the **staging wallet** during an SC-dev offboarding.

The staging wallet is the `devWallet` EOA (`config/global.json` → `devWallet`). It owns every
EVM **staging** `LiFiDiamond` and pays staging gas. Production diamonds are owned by the Safe +
`LiFiTimelockController` and are **out of scope** here — this runbook only rotates staging
ownership and moves the outgoing wallet's funds to the incoming wallet.

Tron is out of scope (EVM only). If a Tron staging diamond needs rotating, handle it separately
with the Tron tooling and update `tronWallets.devWallet` in `config/global.json`.

## Ownership model

Staging diamonds use the `OwnershipFacet` two-step transfer:

1. The current owner calls `transferOwnership(newOwner)` — sets a pending owner.
2. The new owner calls `confirmOwnershipTransfer()` — completes the transfer.

`transferOwnership` is reversible with `cancelOwnershipTransfer()` right up until the new owner
accepts. The pending owner is not readable on-chain (`s.newOwner` is private), so the checker
detects the "transferred but not yet accepted" state by simulating `confirmOwnershipTransfer`
from the incoming owner (a read-only `eth_call`).

## Tooling

| Script | Purpose |
| --- | --- |
| `script/tasks/rotateStagingDiamondOwner.ts` | `check` / `transfer` / `confirm` across all EVM staging diamonds |
| `script/tasks/moveNativeFundsToNewWallet.ts` | Sweep native gas from the outgoing wallet to the incoming wallet |
| `script/tasks/moveTokenFundsToNewWallet.ts` | Sweep a curated list of ERC20 balances |

The incoming owner defaults to the address derived from `PRIVATE_KEY_NEW`; the outgoing owner /
signer defaults to `PRIVATE_KEY`. Both are overridable via flags.

## Order of operations

The ordering is deliberate — gas is the constraint:

1. **`transfer`** — the outgoing wallet still has gas, so it initiates every `transferOwnership`.
2. **ERC20 sweep** — the outgoing wallet still has gas to move its tokens.
3. **Native sweep (last)** — drains the outgoing wallet's gas into the incoming wallet, which
   both funds the incoming wallet for step 4 and consolidates the remaining balance.
4. **`confirm`** — the incoming wallet (now funded) accepts ownership on every diamond.
5. **Flip config** — set `config/global.json` → `devWallet` to the incoming address.

> **Do not sweep native before the ERC20 sweep or before the transfers.** The native sweep
> leaves the outgoing wallet with only dust, after which it can no longer pay gas to move ERC20
> or to send the transfers.

## Procedure

Prerequisites: `.env` has `PRIVATE_KEY` (outgoing wallet) and `PRIVATE_KEY_NEW` (incoming
wallet); premium RPCs configured for the active networks. Work in a dedicated worktree.

```bash
# 0. Baseline (read-only). Exits non-zero until every diamond is transferred.
bunx tsx ./script/tasks/rotateStagingDiamondOwner.ts check

# 1. Initiate transfers (dry-run first, then --execute).
bunx tsx ./script/tasks/rotateStagingDiamondOwner.ts transfer
bunx tsx ./script/tasks/rotateStagingDiamondOwner.ts transfer --execute

# 2. ERC20 sweep (only tokens worth more than gas; curate the list from a portfolio export).
#    tokens.json shape: { "<network>": ["0xTokenAddress", ...] }
bunx tsx ./script/tasks/moveTokenFundsToNewWallet.ts <incomingAddress> --tokens tokens.json
bunx tsx ./script/tasks/moveTokenFundsToNewWallet.ts <incomingAddress> --tokens tokens.json --execute

# 3. Native sweep (LAST — drains the outgoing wallet's gas).
bunx tsx ./script/tasks/moveNativeFundsToNewWallet.ts --newWalletAddress <incomingAddress> --privateKeyEnvKey PRIVATE_KEY

# 4. Accept ownership from the incoming wallet.
bunx tsx ./script/tasks/rotateStagingDiamondOwner.ts confirm
bunx tsx ./script/tasks/rotateStagingDiamondOwner.ts confirm --execute

# 5. Flip config: set config/global.json -> devWallet to the incoming address, commit.

# 6. Verify: exits 0 when every diamond is owned by the incoming wallet.
bunx tsx ./script/tasks/rotateStagingDiamondOwner.ts check
```

If a `confirm` fails on a chain for insufficient gas (the outgoing wallet held too little native
to leave the incoming wallet enough), top up that chain and re-run `confirm --execute` — it is
idempotent and only acts on diamonds still pending.

## Verifying the new state

`check` is the single source of truth. It reports one of three states per network:

- ✅ **done** — owner is the incoming wallet.
- ⏳ **pending-accept** — transfer initiated, awaiting `confirmOwnershipTransfer`.
- ❌ **not-started** — still owned by the outgoing wallet.

It exits `0` only when all diamonds are `done`, so it doubles as a CI/gate check.

# HyperEVM Big Blocks

## Why this matters

HyperEVM has a [dual-block architecture](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/dual-block-architecture):
transactions target either **small blocks** (fast, ~1s, ~2–3M gas) or **big
blocks** (slow, ~1min, **30M gas**). Contract deployments exceed the small-block
gas limit, so **any wallet that deploys on `hyperevm` must have big blocks
enabled**.

Big blocks are **opt-in per address** and the setting does **not** carry over
when we rotate wallets — every new deployer / dev EOA must be enabled
individually.

## Prerequisite: the wallet must be a HyperCore "Core user"

The toggle is a Hyperliquid **L1 action** (`evmUserModify`), and only an
existing Core user can send an L1 action. An EOA becomes a Core user the first
time it **receives a Core asset (USDC or HYPE) on HyperCore** — the L1 / spot
side, **not** HyperEVM. Bridging funds to the HyperEVM side does not register a
Core user.

Registration is **permanent**: once an address has any Core state it stays a
Core user even after the balance is withdrawn.

## Runbook (validated)

Do this once per new wallet. It needs **~5 USDC + a little ETH for Arbitrum
gas**, which you recover at the end (minus the ~$1 Hyperliquid withdrawal fee).
We don't keep standing balances on these wallets, so **source the USDC fresh
each time** (e.g. swap/bridge via [Jumper](https://jumper.exchange) to the
wallet on Arbitrum) — you can't rely on leftover funds from a previous run.

1. Get **~5 USDC (+ gas ETH)** onto the wallet **on Arbitrum** (Hyperliquid's
   native bridge is Arbitrum ↔ Hyperliquid).
2. Connect the wallet at <https://app.hyperliquid.xyz/trade> → **Deposit** ≥ 5
   USDC (5 is the minimum; smaller deposits are lost). This credits the wallet
   on **HyperCore**, registering it as a Core user.
3. Connect the wallet at <https://hyperevm-block-toggle.vercel.app/> and **enable
   big blocks** (signs `evmUserModify` with `usingBigBlocks=true`). Toggle off to
   revert.
4. **Withdraw** the USDC back to Arbitrum (~$1 fee). The wallet stays a Core
   user.

The wallet's HyperEVM deploys now target the 30M-gas big blocks.

## Shortcut when a funded Core account already exists

If you already control a wallet that is a Core user with a spot balance (e.g. the
outgoing deployer before it is drained), skip the bridge deposit: from that
account, **Send** a dust spot transfer (USDC or HYPE) to the new address.
Internal Hyperliquid sends are gasless and land on the recipient's Core balance,
registering it. Then do step 3 above. This avoids sourcing 5 USDC but requires an
already-registered, funded account to send from.

## Gas note

Registration and the toggle are **gasless** signed L1 actions — they cost no gas.
The only HYPE you need is for the **actual contract deployment** (HyperEVM's
native gas token is HYPE), which is the normal deployer-funding step. USDC is
never gas on HyperEVM.

## Verify (read-only)

Confirm an address is a Core user via the Hyperliquid info API (no keys, no
funds):

```bash
curl -s https://api.hyperliquid.xyz/info \
  -H 'Content-Type: application/json' \
  -d '{"type":"spotClearinghouseState","user":"0xNEW"}'
```

A non-empty `balances` array (or an existing account) means the address is
registered. Estimate gas on big blocks with the `bigBlockGasPrice` JSON-RPC
method in place of `gasPrice`.

## When this applies

Every new deploying wallet on `hyperevm`, most commonly on **wallet rotations**.
`rotate-deployer-wallet` and `rotate-dev-wallet` flag this in their funding
phase, and `offboard-sc-dev` flags it in Phase 1. The **pauser is exempt** — it
does not deploy.

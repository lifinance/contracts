---
name: manage-wallet-funds
usage: /manage-wallet-funds
description: "Moves funds for a wallet whose key is in `.env` via the LI.FI API: `bridge`/`swap` within one wallet (autonomous) or `send` to another recipient (human `--confirm` only). Use for \"dev wallet has no gas on X\". Tron → `interact-tron`; automate-wallet funding → `request-dev-funds`."
---

# Manage Wallet Funds

Engine: `script/tasks/manageWalletFunds.ts`; this document is the policy around it. EVM only — Tron/Tronshasta → `/interact-tron` (say so and stop); Solana / BTC / SUI unsupported.

## Autonomy boundary

Custody is the line: a move that keeps funds in one wallet can't lose them to anyone; a move that changes who controls them can.

| Mode | Destination | Behaviour |
|------|-------------|-----------|
| `bridge` | same wallet, other chain | autonomous |
| `swap` | same wallet, same chain | autonomous |
| `send` | a different recipient | refuses to broadcast without `--confirm` |

`bridge`/`swap` quote with `toAddress == fromAddress` and abort if they differ. `send` prints the report and exits unless a human appends `--confirm` after reading it. An agent or sub-agent never supplies `--confirm`, and a broad task ("get the deployment working") is not standing permission to send funds elsewhere.

Never print the private key (the script surfaces only the derived address) or a full RPC URL (may embed API keys).

## Resolving the wallet

`--wallet` takes a role or raw address:

- Role (`devWallet`, `refundWallet`, `deployerWallet`, `pauserWallet`, `withdrawWallet`, `backendSignerProduction`, …) → `config/global.json` `walletKeys` → `.env` var → derived address.
- Raw `0x…` → matched against addresses derived from every registry key and any other `*PRIVATE_KEY*` in `.env`; no match → refuses.

The derived address is cross-checked against `global.json` for that role; a mismatch aborts — after a rotation, update `global.json` first. `feeCollectorOwner` has no key in `.env`. `refundWallet` / `withdrawWallet` are CTO-owned — double-check intent before moving their funds.

## Running it

Run with `--dry-run` first to validate the route and the same-wallet gate without signing.

```bash
# bridge native gas, same wallet, arbitrum -> bsc
bunx tsx script/tasks/manageWalletFunds.ts bridge --wallet devWallet \
  --from-network arbitrum --to-network bsc --amount 0.01 [--dry-run]

# swap native -> USDC on base, same wallet
bunx tsx script/tasks/manageWalletFunds.ts swap --wallet devWallet \
  --network base --from-token native --to-token USDC --amount 0.01 [--dry-run]

# send native gas to a different recipient — prints a report and STOPS
bunx tsx script/tasks/manageWalletFunds.ts send --wallet devWallet \
  --network bsc --to 0xRecipient --amount 0.01
```

- One route tx per invocation (an ERC-20 input first sends an approval if allowance is short; that receipt alone is not the move); confirm the route result before the next. Never loop the script.
- Amount: `--amount <human>` of the input asset, or `--percent <n>` of native balance (native inputs only; leaves gas headroom).
- `--max-slippage` (default 3%) aborts if the quote's USD-measured loss exceeds it or the route has no USD pricing.
- Tokens: `native`, `0x…`, or a symbol from the LI.FI token list (ambiguous symbol aborts — pass the address).
- `send` moves the true native asset only. Where gas is an ERC-20 (arc's USDC gas-token predeploy; tempo's `feeTokenAddress` model) `send` refuses; `bridge`/`swap` still work there.
- Both chains must be in the LI.FI API's supported list; a not-yet-indexed new network stops with "move those funds manually".

## After a move

`swap` / `send` wait for the receipt and report explorer link and balance. `bridge` delivers asynchronously: the script polls the LI.FI status endpoint until destination funds land, or reports where to track it.

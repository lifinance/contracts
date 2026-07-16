---
name: manage-wallet-funds
usage: /manage-wallet-funds
description: Bridge, swap, or send funds from any wallet whose private key is in `.env`, routing through the LI.FI API. Three modes — `bridge` (move the native gas asset cross-chain, same wallet on both ends), `swap` (same-chain native↔ERC-20 in either direction, same wallet), and `send` (gas asset to a different recipient). Use whenever an agent or engineer needs to move or provision funds for one of our wallets: "the dev wallet is out of gas on BSC", "bridge some ETH to base to test a route", "swap native into USDC so I can test", "get the funds I need to test X", "rebalance the deployer across chains", "send 0.1 ETH to 0x… on optimism", or `/manage-wallet-funds …`. `bridge` and `swap` keep custody inside one wallet and run autonomously; `send` changes custody and requires an explicit human `--confirm` that an agent must never set on its own. Resolves the wallet by role (devWallet, refundWallet, deployerWallet, pauserWallet, …) or raw address from `config/global.json` `walletKeys` + `.env`. EVM only — Tron routes to `interact-tron`. Requires `bun` and the wallet's key in `.env`.
---

# Manage Wallet Funds

Move funds for any wallet we hold the key for, using the LI.FI API as the router. The
engine is `script/tasks/manageWalletFunds.ts`; this document is the policy around it.

## When to trigger

- "the dev wallet has no gas on BSC" / "rebalance the deployer to arbitrum"
- "bridge 0.02 ETH to base so I can test" / "get me some USDC on optimism to test a swap"
- "swap native into USDC on base" (or the reverse)
- "send 0.1 ETH to 0xRecipient on polygon"
- `/manage-wallet-funds <free-form request>`

## When to skip

- Target chain is Tron/Tronshasta → LI.FI transactions and `cast` do not apply there;
  route to `/interact-tron`. Say so and stop.
- The chain is otherwise non-EVM (Solana / BTC / SUI) → unsupported.
- Funds need to come **into** one of our wallets from the automate-wallet → that is
  `request-dev-funds` (a PR flow), not this direct-key path.

## The autonomy boundary (the point of this skill)

Custody is the line. A move that keeps funds inside one wallet cannot lose them to
anyone, so it needs no human in the loop. A move that changes who controls the funds
can, so it always does.

| Mode | Destination | Behaviour |
|------|-------------|-----------|
| `bridge` | same wallet, other chain | autonomous — no confirmation |
| `swap` | same wallet, same chain | autonomous — no confirmation |
| `send` | a different recipient | refuses to broadcast without `--confirm` |

For `bridge`/`swap` the script quotes with `toAddress == fromAddress` and asserts it before
broadcasting; if anything makes the destination differ from the source, it aborts. For
`send`, the recipient differs by definition, so the script prints the report and exits
unless a human passes `--confirm` after reading it. An agent or sub-agent must never
supply `--confirm` itself, and must never treat a broad task ("get the deployment
working") as standing permission to send funds to another address.

## Secrets hygiene (non-negotiable)

The script reads a private key from `.env` and signs a real, irreversible transaction.

- Never print, echo, or log the private key — not in output, not in errors, not in the
  report. The script only ever surfaces the derived address.
- Never print full RPC URLs (they can embed API keys). Refer to the network name or the
  host, never the query string.

## Resolving the wallet

Pass `--wallet` as a role or a raw address:

- **Role** (`devWallet`, `refundWallet`, `deployerWallet`, `pauserWallet`,
  `withdrawWallet`, `backendSignerProduction`, …) → resolved via `config/global.json`
  `walletKeys` to the matching `.env` variable, then the address is derived from the key.
- **Raw `0x…`** → matched against the addresses derived from every key in the registry
  and any other `*PRIVATE_KEY*` variable in `.env`. If no key derives to it, the script
  refuses — it can only move funds it holds the key for.

The address is always derived from the key, and cross-checked against the address
`global.json` records for that role; a mismatch **aborts** — a wrong or stale key must
not silently operate a different wallet, so if the wallet was rotated, update
`global.json` first. `feeCollectorOwner` has no key in `.env` and cannot be driven here.

Prefer the wallet the request names. `refundWallet` / `withdrawWallet` are CTO-owned —
double-check intent before moving their funds.

## Running it

Add `--dry-run` first to validate the route and the same-wallet gate without signing —
useful before any real move.

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

For `send`, a **human** appends `--confirm` to the command above after reading the report. An agent must never add it — that is the whole point of the gate, so the example is intentionally left un-confirmed.

One broadcast per invocation: each command signs at most one transaction; confirm the result before running the next. Do not loop this script to fire several transfers inside a single step.

Amount is either `--amount <human>` (of the input asset) or `--percent <n>` of the native
balance (native inputs only; leaves headroom for gas). `--max-slippage` caps tolerated
value loss and defaults to 3% — the script aborts if the quote's USD-measured loss exceeds
it, or if the route has no USD pricing to check against.

Tokens are `native`, a `0x…` address, or a symbol (resolved via the LI.FI token list;
an ambiguous symbol aborts — pass the address).

`send` moves the true native asset (a plain value transfer). On chains where gas is paid in
an ERC-20 rather than a spendable native coin — a gas-token predeploy (arc, where gas is
USDC) or the "no native currency" model (tempo, gas via a `feeTokenAddress`) — `send` refuses
rather than broadcasting the wrong thing (or nothing). `bridge`/`swap` still route those
through LI.FI normally; a direct `send` there is a follow-up.

## Chain support

Routing goes through the LI.FI API only. Before quoting, the script checks both chains
against the API's supported-chain list. A chain that is still being added is not indexed
yet, so the script stops and says to move those funds manually rather than hang. This is
expected for brand-new networks.

## After a move

- `swap` / `send` confirm synchronously — the script waits for the receipt and reports the
  explorer link and resulting balance.
- `bridge` delivers to the destination asynchronously — the source tx confirms quickly,
  then the script polls the LI.FI status endpoint until the destination funds land (or
  reports where to track it if it is still pending). Do not expect the destination balance
  to update the instant the source tx confirms.

## Related skills

- `interact-tron` — the Tron analog; route here when the chain is Tron.
- `request-dev-funds` — fund a wallet **from** the automate-wallet via a PR, when there is
  no source wallet to move from.
- `sweep-wallet-funds` — drain a rotated-out wallet's native gas across every chain during
  a rotation.

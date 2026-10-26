---
name: interact-tron
description: "Reads or writes Tron (`tron`/`tronshasta`) contract state with `troncast`, the `cast` analog: calls, sends, TRX transfers, address conversion, bytecode. Use for \"call owner() on tron\" / \"send TRX\". Deploys → `deploy-contract-tron`; governance → Tron Safe+Timelock, not this skill."
usage: /interact-tron <call|send|address|code> ...
---

# Interact with Tron Contracts

`cast` fails on Tron (TronGrid public endpoints don't support `eth_getTransactionCount` or `debug_traceTransaction`). Use `troncast` (`script/troncast/`); never hand-roll TronWeb for something it covers. Runs from the `contracts` checkout — no `contracts-tron` fork needed (the fork matters only for deploys and `LibAsset`/`WithdrawablePeriphery` changes; see `docs/TronFork.md`).

Routing:

- Deploy → `/deploy-contract-tron`.
- Production governance (whitelist sync, ownership transfer, anything via the Timelock) → `propose-to-safe-tron.ts` conventions (Safe quorum + `scheduleBatch`/`executeBatch`). Flag it and get explicit direction; don't improvise call data here.
- Past transaction/trace → `/analyze-tx`.

## Addresses (`[CONV:TRON-ADDRESS]`, `202-tron-scripts.md`)

Base58 (`T…`) at the RPC/display layer; internally `0x41` + 20-byte EVM address. `call`/`send`/`code` accept either, so convert only when the other format is needed back or when hand-composing calldata:

```bash
bun troncast address to-hex TLPh66vQ2QMb64rG3WEBV5qnAhefh2kcdw     # -> 0x7252af...
bun troncast address to-base58 0x7252afce04856eaac8f8a8beb5ae29621a1ca49b   # -> TLPh66...
```

`address` always requires `ETH_NODE_URI_TRON` even though conversion is offline — the codec hardcodes the mainnet TronWeb instance, so `ETH_NODE_URI_TRONSHASTA` doesn't satisfy it and there is no `--env` flag. If unset, prefix a dummy value for that invocation; don't edit `.env`.

## Read — `call` / `code`

```bash
bun troncast call <DIAMOND> "owner() returns (address)" --env mainnet
bun troncast call <TOKEN> "balanceOf(address) returns (uint256)" <WALLET> --env mainnet
bun troncast call <TOKEN> "decimals() returns (uint8)" --env mainnet --json
bun troncast code <address> --env mainnet
```

`--env` defaults to `mainnet`; `testnet` = `tronshasta`.

## Write — `send`

```bash
bun troncast send <TOKEN> "transfer(address,uint256)" <RECEIVER>,1000000 --private-key-env PRIVATE_KEY_PRODUCTION

# native TRX: --value, no function signature
bun troncast send <RECIPIENT> --value 0.1tron --private-key-env PRIVATE_KEY_PRODUCTION

bun troncast send <TOKEN> "approve(address,uint256)" <SPENDER>,1000000 --dry-run
```

Flags: `--private-key-env` (prefer over `--private-key`, which lands in shell history), `--value` (`0.1tron` / `100000sun` / raw sun), `--fee-limit` (TRX cap, default 1000), `--energy-limit`, `--dry-run`, `--no-confirm`, `--json`.

- `--dry-run` first for any fresh signature, new target, or non-trivial value.
- One broadcast per tool call; confirm before the next. Never loop `send`.
- Derive the sender from the key. `global.json` `tronWallets` is for identification and delegation bookkeeping, not proof of which key signs.

## Energy and fee limit

Set `--fee-limit` deliberately for anything beyond a cheap call. `send` pre-flights every contract call: it estimates Energy, prices it, and refuses before broadcasting if the cost exceeds `--fee-limit` or no estimate is obtainable — so out-of-energy shows up as a refusal naming the required limit, not a half-applied tx. A failed estimate usually means the call would revert; investigate before raising the limit. `ALLOW_GAS_ESTIMATE_FALLBACK=<network>` broadcasts anyway — scope it to the network, since `true` disables the guard for every network in the run. Native TRX transfers are exempt.

Timelock `scheduleBatch`/`executeBatch` run on Energy delegated to `deployerWallet`/`devWallet` from staked TRX — human-arranged (ping Max), out of scope here.

## Gaps and failures

`troncast` has no ABI auto-fetch, verification, wallet management, chain forking, or event-log filtering, and limited gas estimation — say so rather than writing ad hoc TronWeb outside `script/troncast/`.

- Revert with no reason → `--dry-run`, and check the target is base58 or `0x` hex, not a hybrid.
- `exceeds the fee limit` → re-run with the named `--fee-limit`; nothing was broadcast.
- `Energy estimation failed` → likely revert; diagnose. Same message on TronGrid 429 / RPC death after retries — wait and re-run, or set `ALLOW_GAS_ESTIMATE_FALLBACK=tron` if the send (e.g. a break-glass pause) must proceed.
- `proto is not defined` → TronWeb/Bun hiccup; retry once before investigating.

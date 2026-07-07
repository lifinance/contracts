---
name: interact-tron
description: Reads or writes Tron contract state outside of a deploy — the TronWeb/`troncast` analog of using `cast` on EVM chains. Use whenever the target network is `tron`/`tronshasta` and the user wants to call a view function, send a transaction (transfer, approve, admin call), check/convert an address, or fetch bytecode — e.g. "check the balance on tron", "send TRX to X", "call owner() on the tron diamond", "what's the base58 for this address". Also the routing target when `send-deployer-funds` or another EVM-flavored skill detects a Tron network and cannot proceed with `cast`. Runs entirely from the `contracts` checkout (`troncast` lives at `script/troncast/`) — unlike `deploy-contract-tron`, no `contracts-tron` fork checkout is needed, since reading/writing on-chain state doesn't touch the fork's `-tron` source delta. Does NOT cover deploying new contracts (`deploy-contract-tron`) or production governance proposals through the Tron Safe+Timelock (`propose-to-safe-tron.ts` — flag and hand off, don't improvise call data through this skill). Background on the fork/repo split: `docs/TronFork.md`.
usage: /interact-tron <call|send|address|code> ...
---

# Interact with Tron Contracts

Tron has its own address format, RPC surface, and resource model, so `cast` does not work against it (`eth_getTransactionCount` and `debug_traceTransaction` aren't supported on TronGrid public endpoints). All read/write contract interaction on Tron goes through `troncast` (`script/troncast/`), a Cast-like TronWeb wrapper — never hand-roll a TronWeb script for something `troncast` already covers.

**Repo: stay in `contracts`.** Unlike `/deploy-contract-tron`, this skill needs no `contracts-tron` fork checkout — `troncast` and the deployed contract's on-chain state are both reachable from the normal `contracts` session. See `docs/TronFork.md` for why the fork exists at all and when it *does* matter (deploys and any change to `LibAsset`/`WithdrawablePeriphery`).

## When to reach for this vs other skills

| Situation | Skill |
|---|---|
| Deploying a new contract to Tron | `/deploy-contract-tron` |
| Read a Tron contract's state, or send a simple write (transfer, approve, single admin call) | **this skill** |
| Move gas (TRX) from our own deployer wallet | this skill (`troncast send ... --value`) |
| Production governance change (whitelist sync, ownership transfer, anything needing the Timelock) | route to `propose-to-safe-tron.ts` conventions — this needs Safe-quorum + `scheduleBatch`/`executeBatch` sequencing, not a one-off `troncast send`. Flag it and get explicit direction rather than improvising. |
| Analyzing a past Tron transaction/trace | `/analyze-tx` (already has a Tron-specific section) |

## Address handling ([CONV:TRON-ADDRESS], see `202-tron-scripts.md`)

Tron addresses are base58 (`T...`) at the RPC/display layer, 21-byte hex (`0x41` prefix + 20-byte EVM address) internally. Convert explicitly at the point of use — never assume a hex address the user pastes is already in the right form for a given call:

```bash
bun troncast address to-hex TLPh66vQ2QMb64rG3WEBV5qnAhefh2kcdw     # -> 0x7252af...
bun troncast address to-base58 0x7252afce04856eaac8f8a8beb5ae29621a1ca49b   # -> TLPh66...
```

`troncast` itself accepts either format for `call`/`send`/`code` target addresses, so conversion is only needed when the user needs the *other* format back, or when composing calldata by hand.

## Reading state — `troncast call`

```bash
bun troncast call <address> "<functionSignature> returns (<type>)" [params...] --env <mainnet|testnet>

# examples
bun troncast call <DIAMOND> "owner() returns (address)" --env mainnet
bun troncast call <TOKEN> "balanceOf(address) returns (uint256)" <WALLET> --env mainnet
bun troncast call <TOKEN> "decimals() returns (uint8)" --env mainnet --json
```

`--env` defaults to `mainnet`; use `testnet` for `tronshasta`. Function signatures follow the same Solidity/Foundry format as `cast` (`transfer(address,uint256) returns (bool)`).

## Fetching bytecode — `troncast code`

```bash
bun troncast code <address> --env mainnet   # analog of `cast code`
```

## Sending transactions — `troncast send`

```bash
bun troncast send <address> "<functionSignature>" [params...] --private-key <KEY> --env <mainnet|testnet>

# transfer tokens
bun troncast send <TOKEN> "transfer(address,uint256)" <RECEIVER>,1000000 --private-key "$KEY"

# send TRX (native)
bun troncast send <address> "deposit()" --value 0.1tron --private-key "$KEY"

# dry run first for anything non-trivial
bun troncast send <TOKEN> "approve(address,uint256)" <SPENDER>,1000000 --dry-run
```

Key flags: `--value` (`0.1tron` / `100000sun` / raw sun), `--fee-limit` (TRX cap, default 1000), `--energy-limit`, `--dry-run` (simulate, no broadcast), `--no-confirm`, `--json`.

**One broadcast per tool call.** Same rule as `send-deployer-funds`: never loop `troncast send` inside a single tool call — one signed transaction per invocation, confirm the result before sending the next.

**Derive the sender from the private key, not `config/global.json`.** `global.json` → `tronWallets` lists known-role addresses (`deployerWallet`, `devWallet`, `refundWallet`, ...) for identification and delegation bookkeeping — it is not a source of truth for which key you're about to sign with. Confirm you're using the intended wallet's key before broadcasting.

**Dry-run before any non-trivial write.** `--dry-run` simulates without broadcasting and costs nothing — use it whenever the call isn't a simple, previously-verified pattern (a fresh function signature, a new target contract, or anything moving more than trivial value).

## Energy & fee-limit awareness

Tron pays for execution in Energy (≈ gas), not just bandwidth. `--fee-limit` is a TRX ceiling on what the transaction may consume if it must buy Energy — set it deliberately for anything beyond a cheap call rather than trusting the 1000 TRX default. If a write repeatedly fails with an out-of-energy-style error, that's a fee-limit or energy-limit problem, not a revert — raise `--fee-limit`/`--energy-limit` and retry rather than assuming the call itself is wrong.

Ongoing higher-volume Tron operations (the Timelock's `scheduleBatch`/`executeBatch`) run off **delegated** Energy from staked TRX on `deployerWallet`/`devWallet` rather than burning TRX per call — that delegation is a separate, human-arranged concern (ping Max) and out of scope for a one-off `troncast` interaction.

## Known `troncast` gaps

No ABI auto-fetch, no contract verification, no wallet management, limited gas estimation, no chain forking, no event-log filtering. For anything needing these, say so explicitly rather than working around them with ad hoc TronWeb code outside `script/troncast/`.

## Failure modes

- `cast` used against a Tron network → will fail on RPC methods Tron doesn't support; switch to `troncast`.
- Function call reverts with no clear reason → dry-run first (`--dry-run`), then check the target address is in the form `troncast` expects (base58 or 0x-hex, not a malformed hybrid).
- Transaction fails after broadcast with an energy-related error → raise `--fee-limit`/`--energy-limit`, don't assume the calldata was wrong.
- Request turns out to need Safe/Timelock sequencing (multi-step, quorum, or anything touching production governance) → stop and hand off; this skill is for direct one-off calls only.

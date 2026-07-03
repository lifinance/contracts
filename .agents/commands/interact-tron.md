---
name: Interact with Tron contracts
description: Read/write Tron smart contracts via the troncast CLI (call, send, code, address conversion)
---

> **Usage**: `/interact-tron <call|send|code|address> ...`

Wraps `script/troncast` — a Cast-like CLI for Tron, since Foundry's `cast`/`forge`
don't support Tron's address format or signing scheme. Use this whenever the user
wants to read state from, or send a transaction to, a deployed Tron contract
(mainnet `tron` or testnet `tronshasta`).

Full command reference and flag list: `script/troncast/README.md`. Tron-specific
TS conventions (TronWeb vs viem, address handling, RPC config) for editing
troncast/tron scripts: `[CONV:TRON-ADDRESS]` / `[CONV:TRONWEB-FACTORY]` in
`202-tron-scripts`.

## Before running any command

1. **Resolve the address format.** Tron contract/wallet addresses are
   base58 (`T...`); the repo's internal representation is EVM hex
   (`0x...`, 21 bytes / 42 hex chars — one byte longer than a normal EVM
   address). `troncast` accepts either and auto-converts, but when unsure,
   convert first with `bun troncast address to-base58 <hex>` or
   `to-hex <base58>`.
2. **RPC env var required even for offline conversions.** `bun troncast
   address to-base58/to-hex` still requires `ETH_NODE_URI_TRON` (or
   `ETH_NODE_URI_TRONSHASTA`) to be set in `.env`, even though the
   conversion itself is a pure offline codec operation — the CLI aborts
   without it. If neither is set, prefix a dummy value for that one
   invocation rather than editing `.env`.
3. **Pick `--env`.** Defaults to `mainnet`; pass `--env testnet` for
   Shasta. RPC URLs resolve from `config/networks.json` first, hardcoded
   fallback second.

## Commands

```bash
# Read-only call
bun troncast call <address> "<functionSignature> returns (<type>)" [params...] --env <mainnet|testnet> [--json]

# State-changing transaction (requires signing key)
bun troncast send <address> "<functionSignature>" [params...] --env <mainnet|testnet> [--value <n>tron|<n>sun] [--private-key <key>|env] [--dry-run] [--fee-limit <trx>] [--energy-limit <n>] [--no-confirm]

# Fetch deployed bytecode
bun troncast code <address> --env <mainnet|testnet>

# Address codec (comma-separated for batch)
bun troncast address to-hex <base58[,base58...]>
bun troncast address to-base58 <hex[,hex...]>
```

Function signatures use Foundry/Solidity syntax:
`transfer(address,uint256) returns (bool)`.

## Workflow

1. Ask for (or infer from context) the target network (`mainnet`/`testnet`),
   the contract address, and the operation (read vs. write).
2. For a **read**, run `troncast call` and report the decoded result.
3. For a **write**, first run with `--dry-run` (or omit `--private-key` to
   preview) and show the user the intended calldata/value before sending
   for real — Tron transactions cannot be undone once broadcast.
4. Never hardcode or print a private key in shell history-visible output;
   prefer the environment-variable path (`getPrivateKey()`) over
   `--private-key <literal>` when the user has a key configured.
5. If a call fails with `proto is not defined`, this is a known
   TronWeb/Bun compatibility hiccup — retry the same command once before
   investigating further.

## Known limitations (do not attempt to work around)

No ABI auto-fetch from TronScan, no contract verification, no wallet
management, no chain forking, no event-log filtering, no ENS/TNS
resolution. If the user's ask needs one of these, say so explicitly
instead of improvising a partial workaround.

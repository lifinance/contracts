---
name: simulate-calldata
description: Simulate and analyze calldata on a given network (premium RPC, cast-first)
usage: /simulate-calldata <network> <to> <calldata> [--from <address>] [--value <value>] [--block <number|latest>] [--timestamp <unix>] [--gas-limit <number>] [--expect-revert] [--label <addr=name> ...] [--rpc-env <ENV_VAR>] [--compact]
---

# Calldata Simulation + Analysis Command (cast-first, premium RPC)

> **Usage**: `/simulate-calldata <network> <to> <calldata> [flags...]`

Examples:

- Simulate a router call at a timestamp:
  - `/simulate-calldata berachain 0x24ac999ff132b32c5b3956973b6213b0d07eb2c7 0xa1de4537... --from 0x37c1...bc86 --timestamp 1768835371`
- Simulate a Diamond call at a specific block:
  - `/simulate-calldata arbitrum 0x1234...cafe 0xdeadbeef... --block 284000000`

## When to use this command

- Use when you **have calldata** (and maybe `from/value/block`) and want to know **what it would do**, and **why it would revert**.
- If you have a **real transaction hash**, use `/analyze-tx <network> <tx_hash>` instead (receipt/logs become available and the analysis is stronger).

## Inputs (arguments + flags)

### Mandatory

- `<network>`: network key from `config/networks.json` / `foundry.toml` (e.g. `mainnet`, `arbitrum`, `berachain`)
- `<to>`: target contract address
- `<calldata>`: hex calldata `0x...`

### Optional flags (recommended)

| Flag                       | Default                                   | Purpose                                                    |
| -------------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| `--from <address>`         | `foundry.toml` `[profile.default].sender` | Sender for the simulated call                              |
| `--value <value>`          | `0`                                       | `msg.value` (units supported by `cast`, e.g. `1ether`)     |
| `--block <number\|latest>` | unset                                     | Simulate at a specific block                               |
| `--timestamp <unix>`       | unset                                     | Resolve timestamp → block (via premium RPC)                |
| `--gas-limit <number>`     | unset                                     | Supply a gas limit                                         |
| `--expect-revert`          | false                                     | Treat revert as acceptable and still produce a full report |
| `--label <addr=name>`      | unset                                     | Extra labels; used to improve trace readability            |
| `--rpc-env <ENV_VAR>`      | unset                                     | Override which env var provides the premium RPC URL        |
| `--compact`                | false                                     | Keep output short (only key frames + failure path)         |

## Critical rules (non-negotiable)

1. **Premium RPC only**: never silently fall back to public RPC.
2. **Trace-first**: summarize what trace shows; avoid guessing.
3. **Repo-first decoding**: use `diamond.json` + `out/*/methodIdentifiers` before external selector DBs (`cast 4byte`).
4. **Simulation ≠ mined tx**: no receipt; any “events” must be labeled as **simulated**.

## Simulation Workflow (cast-first)

### 1) Parse & validate inputs

- Validate `<to>` is an address and `<calldata>` is `0x` hex.
- If both `--block` and `--timestamp` are provided: stop and ask which one to use.

### 2) Resolve premium RPC (required)

- Resolve the RPC URL from env:
  - If `--rpc-env` provided: use that env var.
  - Else compute `ETH_NODE_URI_<NETWORK>` (uppercase, `-` → `_`).
- If not set: instruct the user to set it and **stop** (do not proceed on public RPC).

### 3) Resolve effective block (optional)

- If `--timestamp` provided:
  - Use `cast find-block --rpc-url <premium> <timestamp>` to resolve a block number.
  - Use that resolved block for the simulation.

### 4) Run traced simulation (the source of truth)

Run:

```bash
cast call --rpc-url "<premium>" \
  --from "<from>" \
  --value "<value>" \
  --block "<block?>" \
  --gas-limit "<gas?>" \
  --trace --decode-internal \
  --data "<calldata>" \
  "<to>"
```

If `--label` flags are provided, translate them into `cast` trace labels (`address:label`) and pass via `--labels` (best-effort).

Capture:

- Root call: target, selector, best-available function name
- Outcome: success/revert + revert reason/custom error (if any)
- Key frames: entrypoint, significant internal calls, approvals/transfers, failure point

### 5) Decode calldata (repo-first)

Decode root calldata:

- Identify selector: first 4 bytes of calldata.
- Prefer function names from trace; otherwise map selector using (in order):
  - `deployments/<network>.json` and `deployments/<network>.diamond.json` (known contracts)
  - `diamond.json` (repo root) (selector → signature map)
  - `out/<ContractName>.sol/<ContractName>.json` `methodIdentifiers` (when contract is known)
  - `cast 4byte <selector>` only as a last resort (label as best-effort)

Decode nested calldata (when present):

- If root calldata contains nested `bytes` destined for `LiFiDiamond`/facets, extract and repeat the decode flow on those payloads.
- For LI.FI calldata, use patterns from `src/Facets/CalldataVerificationFacet.sol` to describe decoded structures:
  - `ILiFi.BridgeData`
  - `LibSwap.SwapData[]` (source swaps)
  - facet-specific parameters (when identifiable)

### 6) Enrich addresses & assets

- Enrich addresses using:
  - `config/whitelist.json` (DEX/periphery names)
  - `deployments/<network>.json` (protocol addresses)
  - user `--label` entries
- For token addresses that appear in decoded params or traces, optionally call:
  - `name()`, `symbol()`, `decimals()` via premium RPC (read-only)

## Output format (keep it tight)

Produce a stakeholder-friendly markdown report (similar spirit to `/analyze-tx`), without dumping full traces:

- **Simulation summary**: network, block/timestamp, from, to, selector/function, value, success/fail
- **Decoded parameters**:
  - Root call params
  - Nested LI.FI params (BridgeData/SwapData) when applicable
- **Execution flow (simulated)**:
  - Key call frames in order
  - Token movements (approvals/transfers) where visible
- **Failure analysis** (if reverted):
  - Revert reason/custom error
  - Exact failing internal call (from trace)
  - “What needs to change to succeed”

### Quality checklist

- Premium RPC used (no public fallback)
- Block selection is explicit (or clearly “latest”)
- Selector/function mapping is verified (repo-first)
- Output distinguishes **simulated** vs **mined** facts

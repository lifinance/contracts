---
name: analyze-tx
description: Analyze a failing transaction by hash and network
usage: /analyze-tx <network> <tx_hash>
---

# Transaction Trace Analysis Command

> **Usage**: `/analyze-tx <network> <tx_hash>` — e.g. `/analyze-tx ethereum 0x1234...abcd`

Both arguments are required; if only a hash was given, ask for the network.

## Trace-first

The execution trace (`debug_traceTransaction`) and the receipt logs are the source of truth;
source code shows only what *should* happen. If a call is not in the trace or an event is not in
the logs, it did not happen, whatever the code implies.

- ❌ "The transaction called `swapAndStartBridgeTokensViaStargate` and emitted
  `LiFiTransferStarted` events."
- ✅ "The trace shows `swapTokensMultipleV3ERC20ToERC20` was called. The receipt logs show
  `LiFiGenericSwapCompleted` was emitted. No `LiFiTransferStarted` events are present."

## Rules that catch real failures here

1. **Premium RPC only** — use `analyzeFailingTx` or a user-supplied premium RPC. A silent
   fallback to a public RPC returns a truncated trace that reads like a complete one.
2. **Confirm LiFiDiamond involvement first** (direct or indirect), or say the transaction is not
   ours and stop.
3. **`msg.value` from the transaction object** (`eth_getTransactionByHash`), not the trace — a
   nested call's value is not the root transaction's.
4. **Cross-check every function selector**, in this order: the function name in the trace, then
   `out/<ContractName>.sol/<ContractName>.json` methodIdentifiers, then
   `cast sig "<FUNCTION_SIGNATURE>"`. Where `cast 4byte` disagrees with the trace, the trace wins
   (e.g. `cast 4byte 0xab138240` returns `bridge(address,address,...)`, but the trace shows
   `swapTokensMultipleV3ERC20ToERC20`).
5. **Events from the receipt logs**, never from the code that would have emitted them.
6. **Enrich every address** via whitelist.json (DEXS/PERIPHERY) → deployments → configs, and
   name the DEX from whitelist.json — never a generic "Router"/"DEX" when a name exists.
7. **Find the config file from the deploy script** — the filename does not always match the
   facet name.
8. **Check native fee requirements** in FacetData.
9. **Find every revert point** — a failing transaction often has more than one, and a nested
   call may have failed without reverting the root.

## Key files

- `deployments/<network>.json` — contract addresses
- `script/deploy/facets/Deploy<FacetName>.s.sol` — names the config file
- `config/<configFileName>.json` — facet external contracts
- `config/whitelist.json` — DEX/router names (`DEXS[]`, `PERIPHERY[]`)
- `config/networks.json` — network metadata (`wrappedNative`, `explorerUrl`, …)
- `src/Facets/<FacetName>.sol`, `src/Libraries/LibSwap.sol` (SwapData)
- `src/Facets/CalldataVerificationFacet.sol` — decoding logic
- `out/<ContractName>.sol/<ContractName>.json` — ABIs with methodIdentifiers

## Workflow

### 1. Fetch transaction data

```bash
./script/tasks/analyzeFailingTx.sh <NETWORK> <TX_HASH>
```

Run it as a plain command from the repo root — a worktree-isolated session refuses inline
`source`. Fallback: ask the user for a premium RPC URL and fetch `eth_getTransactionByHash`
(`from`, `to`, `input`, `value`), `eth_getTransactionReceipt` (status, gas, logs) and
`debug_traceTransaction` with `callTracer` (optionally `cast run`).

### 2. Identify the transaction

Extract `to`, `from`, calldata, `msg.value` (transaction object). Does `to` match LiFiDiamond? If
not, find the LiFiDiamond call in the trace. Map addresses from `deployments/<network>.json`.

### 3. Root call is not LiFiDiamond

1. Research the contract at `<explorerUrl>/address/<CONTRACT_ADDRESS>` (`explorerUrl` from
   `config/networks.json`), e.g. WebSearch `"<explorerUrl>/address/<ADDRESS> contract verified"`;
   take name, signatures, selectors, parameters from Contract → Write Contract.
2. Verify the selector (rule 4), then
   `cast calldata-decode "<FUNCTION_SIGNATURE>" <CALLDATA>` — signature from the trace first,
   then the explorer, then `cast 4byte`.
3. If the router passes data to LiFiDiamond, extract the nested calldata from the `bytes`
   parameter and decode it separately.

If the target is unverified (no artifact in `out/`, `cast 4byte` returns nothing, no signature
from the trace), run [`/analyze-unverified-contract <ADDRESS> <NETWORK>`](analyze-unverified-contract.md)
and use its selectors file to identify the function.

### 4. Facet and protocol

Map the trace's selector to a facet via methodIdentifiers (rule 4). Load
`src/Facets/<FacetName>.sol`, find the config filename in its deploy script, load
`config/<configFileName>.json`.

### 5. Decode LiFiDiamond calldata

Use the `CalldataVerificationFacet` patterns — `extractBridgeData(bytes)` →
`ILiFi.BridgeData`, `extractSwapData(bytes)` → `LibSwap.SwapData[]`,
`extractMainParameters(bytes)` for a quick overview:

```solidity
bridgeData = abi.decode(data[4:], (ILiFi.BridgeData));
(, swapData) = abi.decode(data[4:], (ILiFi.BridgeData, LibSwap.SwapData[])); // if hasSourceSwaps
```

Extract:

- **BridgeData**: transactionId, bridge, integrator, sendingAssetId, receiver,
  destinationChainId, minAmount, hasSourceSwaps, hasDestinationCall
- **SwapData** per swap: callTo (DEX name), approveTo, sendingAssetId, receivingAssetId,
  fromAmount, callData (decode selector), requiresDeposit
- **FacetData**: facet-specific params, native fee requirements

### 6. Address enrichment

1. `config/whitelist.json`: `DEXS[]` → `contracts[<network>]` → match address
   (case-insensitive) → `name`; `PERIPHERY[<network>]` → match → `name`.
2. Fallback: `deployments/<network>.json`.
3. Tokens: may call ERC20 `name()` via the premium RPC (read-only, non-fatal).

### 7. Execution trace and root cause

From the trace: entry point and inputs, each nested call (caller, target, function, value,
success), native value flow, token flow (deposits, approvals, transfers), every revert point and
its error; events from the receipt logs. Root cause: what was expected vs provided, which
validation failed, what is needed to succeed.

## Tron

Use the TronGrid native API — `debug_traceTransaction` is not available on TronGrid public
endpoints, and `eth_getTransactionCount` is unsupported, so `cast call` fails.

```bash
# Full transaction data + internal transactions
curl -s -X POST https://api.trongrid.io/wallet/gettransactioninfobyid \
  -H "Content-Type: application/json" \
  -d '{"value": "<TX_HASH>"}' | jq .

# Raw transaction (calldata, signature)
curl -s -X POST https://api.trongrid.io/wallet/gettransactionbyid \
  -H "Content-Type: application/json" \
  -d '{"value": "<TX_HASH>"}' | jq .
```

`gettransactioninfobyid` fields:

- `contractResult[0]`: 4-byte revert selector (`cast 4byte`)
- `resMessage`: hex-encoded revert string (`xxd -r -p`)
- `internal_transactions[].rejected`: **all** internal txs show `rejected: true` when the outer
  tx reverts — it means effects were rolled back, not that each call failed
- `internal_transactions[].note`: `63616c6c` = "call", `64656c656761746563616c6c` =
  "delegatecall"
- `receipt.energy_usage_total` (incl. sub-calls); `receipt.energy_penalty_total` (extra energy
  for calling certain contracts)

Gotchas:

- `triggerconstantcontract` simulates writes read-only — return values are unreliable for write
  functions (`transfer` may return `false` in simulation but succeed on-chain).
- Addresses are 21 bytes (`0x41` + 20-byte EVM address). Solidity `address` values and
  ABI-encoded `triggerconstantcontract` params use the 20-byte form (no `0x41`; padded to 32
  bytes in ABI).

`troncast` (conventions in `.agents/rules/202-tron-scripts.md`; `address` needs `ETH_NODE_URI_TRON` set
even though it is offline — prefix a dummy value if unset):

```bash
bun troncast address to-hex TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t   # → 0xa614f8…; comma-separated lists OK
bun troncast address to-base58 0xa614f803b6fd780986a42c78ec9c7f77e6ded13c
bun troncast code <base58-or-hex-address> [--env testnet]       # "0x" if not a contract
```

## Output Format

```markdown
# Transaction Analysis: [TX_HASH]

## Transaction Intent

[One-sentence description]

## Root Transaction Details

- **Network:** [name]
- **From:** [address]
- **To:** [contract name] ([address])
- **Function:** [name] ([selector])
- **Value:** [amount] [symbol] (read from the transaction object, not the trace)
- **Status:** [Success/Fail]

## Parameters Decoded

### Root Transaction Parameters (if not direct LiFiDiamond call)

**Contract:** [Contract name from block explorer] ([address])
**Function:** [function name] ([selector])
**Parameters:**

- [Parameter 1]: [value]
- [data (bytes)]: Contains LiFiDiamond calldata (see below)

### BridgeData

[transactionId, bridge, integrator, sendingAssetId, receiver, destinationChainId, minAmount, hasSourceSwaps, hasDestinationCall]

### SwapData (if applicable)

**Swap 1:**

- DEX: [name from whitelist]
- From: [token] ([amount])
- To: [token]
- Router: [contract name] ([address])
- Function: [name] ([selector])

### Facet-Specific Data

[Native Fee Required: [amount], other params]

## Execution Flow

1. **[Step]:** [Description]
   - Caller: [name]
   - Target: [name]
   - Action: [what happened]
   - Result: [success/fail]

[N] **[FAILURE POINT]:** [Description]

- Error: [message]
- Reason: [why failed]

## Root Cause Analysis

**Primary Issue:** [One-sentence summary]

**Detailed Explanation:**

1. [What was expected]
2. [What was provided]
3. [Why it failed]
4. [What's needed to succeed]

## Contract Addresses Reference

[LiFiDiamond, FacetName, External Contracts, Tokens]

## Summary for Stakeholders

**Transaction Purpose:** [What user was trying to do]
**Failure Reason:** [Clear, non-technical explanation]
**Required Fix:** [What needs to change]
**Impact:** [Who/what is affected]
```

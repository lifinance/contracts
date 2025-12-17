---
name: analyze-tx
description: Analyze a failing transaction by hash and network
usage: /analyze-tx <network> <tx_hash>
---

# Transaction Trace Analysis Command

> **Usage**: `/analyze-tx <network> <tx_hash>`
>
> Example: `/analyze-tx ethereum 0x1234...abcd`

## ⚠️ CRITICAL: Trace-First Analysis Principle

**THE EXECUTION TRACE AND LOGS ARE THE SOURCE OF TRUTH - THEY SHOW WHAT ACTUALLY HAPPENED.**

### Source of Truth Hierarchy

1. **Execution Trace** (`debug_traceTransaction`) - Shows WHAT ACTUALLY HAPPENED:

   - Every function call that occurred
   - Every contract interaction
   - Value transfers
   - Revert points and error messages

2. **Transaction Receipt Logs** - Shows WHAT EVENTS ACTUALLY EMITTED:

   - Every event that was emitted
   - Event topics and data are facts

3. **Code (Source Files)** - Reference for understanding, NOT facts:
   - Shows what SHOULD happen under normal conditions
   - Helps understand intended behavior
   - Use to understand context, not to claim what happened

### Analysis Rules

✅ **DO:**

- State what trace shows: "The trace shows function X was called"
- State what logs show: "The logs show event Y was emitted"
- Use code to understand context: "Based on the code, function X should..."
- Cross-reference trace with code to understand intent vs. reality

❌ **DON'T:**

- Claim an event was emitted if it's not in the logs
- Claim a function was called if it's not in the trace
- Assume something happened because code shows it should happen
- Hallucinate or infer events/calls that aren't explicitly in trace/logs

**Example:**

- ❌ **WRONG**: "The transaction called `swapAndStartBridgeTokensViaStargate` and emitted `LiFiTransferStarted` events."
- ✅ **CORRECT**: "The trace shows `swapTokensMultipleV3ERC20ToERC20` was called. The receipt logs show `LiFiGenericSwapCompleted` was emitted. No `LiFiTransferStarted` events are present in the logs."

## Quick Checklist

1. ✅ **Fetch Data** - Use premium RPC (via `analyzeFailingTx <NETWORK> <TX_HASH>` or user-provided RPC)
2. ✅ **Identify** - Was LiFiDiamond called? If not, state: "Not one of our transactions"
3. ✅ **Decode** - Extract calldata, `msg.value` (from receipt, NOT trace), map addresses to names
4. ✅ **Facet** - Identify facet, load code, find config file (check deploy script for correct filename)
5. ✅ **Params** - Extract BridgeData, SwapData, FacetData
6. ✅ **Trace** - Analyze step-by-step from ACTUAL trace data (not code assumptions), find ALL revert points
7. ✅ **Events** - Verify events from receipt logs (never assume based on code)
8. ✅ **Root Cause** - Expected vs. provided, why failed, what's needed

## Critical Rules

1. ⚠️ **Premium RPC only** - Use `analyzeFailingTx` or user-provided premium RPC; NEVER silently fall back to public RPCs
2. ⚠️ **LiFiDiamond check first** - Confirm involvement (direct/indirect) or state it's not our transaction
3. ⚠️ **msg.value from receipt** - NOT from trace
4. ⚠️ **TRACE IS SOURCE OF TRUTH** - Never claim something happened if it's not in the trace/logs (see Trace-First Principle above)
5. ⚠️ **VERIFY function selectors** - NEVER assume; ALWAYS cross-check with:
   - Actual function name from trace (preferred)
   - `out/<ContractName>.sol/<ContractName>.json` methodIdentifiers
   - `cast sig "<FUNCTION_SIGNATURE>"` to get expected selector
   - If `cast 4byte` returns different function, use trace function name!
6. ⚠️ **VERIFY events from logs** - NEVER assume events were emitted based on code; check receipt logs
7. ⚠️ **Enrich all addresses** - Use whitelist.json (DEXS/PERIPHERY), deployments, configs
8. ⚠️ **Config file from deploy script** - Don't assume filename matches facet name
9. ⚠️ **DEX names from whitelist.json** - Never use generic terms when specific name available
10. ⚠️ **Check native fees** - Verify FacetData requirements
11. ⚠️ **Find ALL reverts** - There may be multiple failure points
12. ⚠️ **Never assume** - Nested calls may have failed; value may not have come from root tx

## Key Files & Tools

### Files

- `deployments/<network>.json` - Contract addresses
- `script/deploy/facets/Deploy<FacetName>.s.sol` - Find config filename
- `config/<configFileName>.json` - Facet external contracts
- `config/whitelist.json` - DEX/router names (DEXS[] and PERIPHERY[] sections)
- `config/networks.json` - Network metadata (wrappedNative, explorerUrl, etc.)
- `src/Facets/<FacetName>.sol` - Facet code
- `src/Libraries/LibSwap.sol` - SwapData structure
- `src/Facets/CalldataVerificationFacet.sol` - Decoding logic
- `out/<ContractName>.sol/<ContractName>.json` - Compiled contract ABIs with methodIdentifiers

### Tools

- `cast 4byte <SELECTOR>` - Get function signature from selector (4byte.directory)
- `cast calldata-decode "<SIGNATURE>" <CALLDATA>` - Decode calldata using function signature
- `cast sig "<FUNCTION_NAME>"` - Get selector from function name
- `cast tx <TX_HASH> --rpc-url <RPC>` - Get transaction details
- `cast receipt <TX_HASH> --rpc-url <RPC>` - Get transaction receipt (contains logs)
- `web_search` - Search for contract information on block explorers

## Analysis Workflow

### 1. Fetch Transaction Data

**Preferred:**

```bash
bash -lc 'source script/helperFunctions.sh && source script/playgroundHelpers.sh && analyzeFailingTx "<NETWORK>" "<TX_HASH>"'
```

**Fallback:** Ask user for premium RPC URL, use for:

- `eth_getTransactionReceipt` - Contains logs (events that ACTUALLY happened)
- `debug_traceTransaction` (callTracer) - Contains execution trace (what ACTUALLY happened)
- Optional: `cast run`

**Extract:**

- Receipt: status, gas, **logs (EVENTS)**, `to`/`from`, `value`
- Trace: Complete execution flow, nested calls, value flow, ALL revert points

### 2. Transaction Identification

- Extract: hash, network, `to` address, `from`, calldata, `msg.value` (from receipt)
- Check: Does `to` match LiFiDiamond? If indirect, trace to find LiFiDiamond call
- Enrich: Map addresses from `deployments/<network>.json`

### 3. Root Transaction Analysis (If NOT Direct LiFiDiamond Call)

When root transaction calls a contract other than LiFiDiamond:

1. **Get block explorer URL:**

   - Read `config/networks.json` → extract `explorerUrl` field

2. **Research contract:**

   - Construct URL: `<explorerUrl>/address/<CONTRACT_ADDRESS>`
   - Use `web_search`: `"<explorerUrl>/address/<CONTRACT_ADDRESS> contract verified"`
   - Navigate to "Contract" tab → "Write Contract" sub-tab
   - Extract: contract name, function signatures, selectors, parameters

3. **Verify function selector (CRITICAL):**

   - Extract selector from trace (first 4 bytes of calldata)
   - Cross-check with actual function name from trace (preferred)
   - Verify using `out/<ContractName>.sol/<ContractName>.json` methodIdentifiers
   - Use `cast sig "<FUNCTION_SIGNATURE>"` to get expected selector
   - **If `cast 4byte` returns different function, use trace function name!**

4. **Decode calldata:**

   - Use verified function signature (from trace preferred, then block explorer, then `cast 4byte` fallback)
   - Decode: `cast calldata-decode "<FUNCTION_SIGNATURE>" <CALLDATA>`

5. **Extract nested calldata:**
   - If router passes data to LiFiDiamond, extract from `bytes` parameter
   - Decode nested LiFiDiamond calldata separately

### 4. Facet & Protocol Identification

1. **Extract function selector from trace:**

   - Get selector from actual call in trace (first 4 bytes of calldata)
   - Example: Trace shows `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE::swapTokensMultipleV3ERC20ToERC20(...)`

2. **Verify selector matches trace:**

   - Cross-check with actual function name from trace (preferred)
   - Verify using `out/<ContractName>.sol/<ContractName>.json` methodIdentifiers
   - Use `cast sig "<FUNCTION_SIGNATURE>"` to get expected selector
   - **Never assume** - if `cast 4byte` returns different function, use trace function name!

3. **Map selector to facet:**

   - Use `out/<ContractName>.sol/<ContractName>.json` methodIdentifiers
   - Verify function signature matches trace

4. **Load facet code:**
   - Load: `src/Facets/<FacetName>.sol`
   - Find config: Check `script/deploy/facets/Deploy<FacetName>.s.sol` for config filename
   - Load config: `config/<configFileName>.json`

**Common Error:**

- ❌ **WRONG**: Seeing selector `0xab138240` and assuming it's `swapAndStartBridgeTokensViaStargate`
- ✅ **CORRECT**: Check `cast 4byte 0xab138240` → returns `bridge(address,address,...)` → verify with trace → trace shows `swapTokensMultipleV3ERC20ToERC20` → use actual function from trace

### 5. Calldata Decoding

#### For Root Transaction (Non-LiFiDiamond)

1. Identify function selector: `cast 4byte <SELECTOR>`
2. Decode calldata: `cast calldata-decode "<FUNCTION_SIGNATURE>" <CALLDATA>`
3. Extract nested calldata if router passes data to LiFiDiamond

#### For LiFiDiamond Calls

Use `CalldataVerificationFacet` patterns:

**BridgeData:**

```solidity
bridgeData = abi.decode(data[4:], (ILiFi.BridgeData));
```

**SwapData (if hasSourceSwaps):**

```solidity
(, swapData) = abi.decode(data[4:], (ILiFi.BridgeData, LibSwap.SwapData[]));
```

**Key functions:**

- `extractBridgeData(bytes calldata data)` → `ILiFi.BridgeData`
- `extractSwapData(bytes calldata data)` → `LibSwap.SwapData[]`
- `extractMainParameters(bytes calldata data)` → Quick overview

### 6. Parameter Extraction

- **BridgeData**: transactionId, bridge, integrator, sendingAssetId, receiver, destinationChainId, minAmount, hasSourceSwaps, hasDestinationCall
- **SwapData** (if applicable): For each swap - callTo (enrich DEX name), approveTo, sendingAssetId, receivingAssetId, fromAmount, callData (decode selector), requiresDeposit
- **FacetData**: Extract facet-specific params, check native fee requirements

### 7. Address Enrichment

**For every address:**

1. Check `config/whitelist.json`:
   - **DEXS section**: `DEXS[]` → `contracts[<network>]` → match address (case-insensitive) → use `name`
   - **PERIPHERY section**: `PERIPHERY[<network>]` → match address → use `name`
2. Fallback: `deployments/<network>.json`
3. Tokens: MAY call ERC20 `name()` via premium RPC (read-only, non-fatal)

**Never use generic terms** ("DexRouter", "Router", "DEX") when specific name available.

### 8. Execution Trace Analysis

**Analyze ONLY what the trace shows - never assume based on code!**

- **Entry point**: Function called (from trace), input params (from trace)
- **Call stack**: Trace each nested call - caller, target, function (from trace), value, params, success/fail
- **Value flow**: Track native value through execution (from trace)
- **Token flow**: Track deposits, approvals, transfers, balances (from trace)
- **Events**: Check receipt logs to see what events were ACTUALLY emitted
- **Failure points**: Identify ALL reverts (from trace), extract error messages

**Rules:**

- ✅ If trace shows function X → state "Function X was called"
- ❌ If code shows function Y should emit event Z → DON'T claim event Z was emitted unless it's in the logs
- ✅ If logs show event A → state "Event A was emitted"
- ✅ Use code to UNDERSTAND what should happen, but trace/logs to report what DID happen

### 9. Root Cause Analysis

- What was expected vs. provided
- Why it failed (specific validation/requirement that wasn't met)
- What's needed to succeed

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
- **Value:** [amount] [symbol] - **CRITICAL: From receipt**
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

[Native Fee Required: [amount] - **CRITICAL**, other params]

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

## Quality Checks

Before finalizing:

- [ ] Premium RPC used (via `analyzeFailingTx` or user-provided)
- [ ] LiFiDiamond involvement confirmed
- [ ] Root tx value verified from receipt
- [ ] **All events verified from receipt logs** (never assume based on code)
- [ ] **All function calls verified from trace** (never assume based on code)
- [ ] Root transaction calldata decoded (if not direct LiFiDiamond call)
- [ ] Block explorer URL obtained and contract researched (if needed)
- [ ] Function selector verified against trace data (never assume!)
- [ ] Selector cross-checked with methodIdentifiers
- [ ] All addresses enriched (whitelist.json → deployments)
- [ ] Correct config file identified from deploy script
- [ ] All DEX names from whitelist.json (no generic terms)
- [ ] All parameters decoded and displayed
- [ ] Execution flow traced completely from trace data
- [ ] ALL failure points identified
- [ ] Root cause clearly explained
- [ ] Summary clear for non-technical readers

## Command Execution Flow

When user invokes `/analyze-tx <network> <tx_hash>`:

1. **Parse arguments**: Extract network and tx_hash from command
2. **Validate inputs**: Ensure network is valid, tx_hash is hex format
3. **Fetch transaction data**: Use premium RPC via `analyzeFailingTx` or prompt for RPC URL
4. **Follow analysis workflow**: Execute all steps from "Analysis Workflow" section
5. **Generate output**: Format results according to "Output Format" section
6. **Quality check**: Verify all items in "Quality Checks" are complete

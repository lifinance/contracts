# Transaction Trace Analysis Prompt

> This prompt is intended to be used **only in “transaction-analysis mode”**, as gated by
> `.cursor/rules/transaction_analysis.cursorrules.mdc` (user provides a tx hash + network and
> explicitly asks to analyze/debug that specific transaction).
>
> Outside of that scope, do **not** apply this prompt.

Use this prompt template when analyzing failing transactions. Follow each step methodically.

**Automated Workflow:** This analysis automatically fetches transaction data using **premium RPC URLs**. User provides transaction hash and network name. The analysis will:

1. If possible, run `analyzeFailingTx <NETWORK> <TX_HASH>` from `script/playgroundHelpers.sh` to fetch receipt, trace, and `cast run` output.
2. Otherwise, ask the user for the **premium RPC URL** for that network and fetch receipt + trace via JSON-RPC calls.
3. Analyze the fetched data using the steps below.

## QUICK REFERENCE CHECKLIST

### Mandatory Steps (Do in Order)

- ✅ **1. Fetch Transaction Data** - Use **premium RPC** (via `analyzeFailingTx` or user-provided RPC URL) to fetch transaction receipt and trace (automated)
- ✅ **2. Transaction Identification** - Extract calldata and target address from fetched data. Identify if LiFiDiamond was called directly, indirectly, or not at all (if not, this is not one of our transactions)
- ✅ **3. Calldata Decoding** - Decode transaction calldata and `msg.value` into human-readable format. Map all addresses to names from available sources
- ✅ **4. Facet & Protocol Identification** - Identify which facet/protocol is being used, load facet code and its config file (check deploy script to find correct config file name)
- ✅ **5. Parameter Extraction** - Extract and decode BridgeData, SwapData, FacetData parameters
- ✅ **6. Trace Analysis** - Analyze execution trace step-by-step, find exactly where revert(s) occur
- ✅ **7. Root Cause Analysis** - Identify what was expected vs. provided, why it failed, what's needed to succeed

### Critical Rules

1. ⚠️ **ALWAYS** fetch transaction data first (receipt + trace) using **premium RPC URLs**:
   - Prefer `analyzeFailingTx <network> <txHash>` (which uses `getRPCUrl` and `.env`/CI secrets)
   - Otherwise use a premium RPC URL explicitly provided by the user
   - ⚠️ **NEVER** silently fall back to public RPC endpoints (including `config/networks.json.rpcUrl`) unless the user explicitly approves it for this analysis
2. ⚠️ **ALWAYS** first identify if LiFiDiamond was called (directly or indirectly) - if not, this isn't our transaction
3. ⚠️ **ALWAYS** verify `msg.value` from transaction receipt, NOT from trace
4. ⚠️ **ALWAYS** enrich all addresses with names from available sources (deployments, configs, whitelist)
5. ⚠️ **ALWAYS** check facet deploy script to find correct config file name (don't assume it matches facet name)
6. ⚠️ **ALWAYS** identify DEX names from `config/whitelist.json` for swap calls
7. ⚠️ **ALWAYS** check native fee requirements in FacetData
8. ⚠️ **ALWAYS** find ALL revert points in trace (there may be multiple)
9. ⚠️ **NEVER** assume nested calls succeeded just because they appear in trace
10. ⚠️ **NEVER** assume value in trace came from root transaction

### Files to Check

- `deployments/<network>.json` - Contract addresses
- `script/deploy/facets/Deploy<FacetName>.s.sol` - Check deploy script to identify which config file the facet uses (config file names don't always match facet names)
- `config/<configFileName>.json` - Facet external contracts (filename found in deploy script)
- `config/whitelist.json` - DEX/router names
- `config/networks.json` - Network info (wrappedNative, etc.)
- `src/Facets/<FacetName>.sol` - Facet code
- `src/Libraries/LibSwap.sol` - SwapData structure
- `src/Facets/CalldataVerificationFacet.sol` - Calldata decoding logic
- `script/playgroundHelpers.sh` - Transaction analysis utilities

---

## CALLDATA DECODING HELPERS

### Using CalldataVerificationFacet Logic

The `CalldataVerificationFacet` provides functions to decode calldata. Use this logic to extract parameters:

**Key Functions:**

- `extractBridgeData(bytes calldata data)` - Extracts `ILiFi.BridgeData` from calldata
- `extractSwapData(bytes calldata data)` - Extracts `LibSwap.SwapData[]` from calldata
- `extractData(bytes calldata data)` - Extracts both BridgeData and SwapData
- `extractMainParameters(bytes calldata data)` - Extracts key parameters (bridge, sendingAssetId, receiver, amount, destinationChainId, hasSourceSwaps, hasDestinationCall)

**Decoding Logic:**

1. **BridgeData Extraction:**

   ```solidity
   // Skip 4-byte function selector, decode remaining calldata
   bridgeData = abi.decode(data[4:], (ILiFi.BridgeData));
   ```

2. **SwapData Extraction (when hasSourceSwaps = true):**

   ```solidity
   // Decode as tuple: (BridgeData, SwapData[])
   (, swapData) = abi.decode(data[4:], (ILiFi.BridgeData, LibSwap.SwapData[]));
   ```

3. **Generic Swap Parameters:**
   - For single swaps: `(bytes32, string, string, address, uint256, LibSwap.SwapData)`
   - For multi swaps: `(bytes32, string, string, address, uint256, LibSwap.SwapData[])`
   - Minimum calldata length: 484 bytes (4 selector + parameters)

**Usage in Analysis:**

- Use these patterns to decode transaction calldata
- Extract BridgeData first to understand transaction structure
- If `hasSourceSwaps = true`, extract SwapData array
- Use `extractMainParameters()` for quick overview

### Automated Trace Fetching

**This step is automated in the analysis process and must use premium RPCs:**

When user provides transaction hash and network name:

1. **Preferred path (with shell access):**
   - Run the local helper:
     - `bash -lc 'source script/helperFunctions.sh && source script/playgroundHelpers.sh && analyzeFailingTx "<network>" "<TX_HASH>"'`
   - This uses `getRPCUrl` to resolve the **premium RPC URL** from environment variables and:
     - Runs `cast run` for an execution trace and revert reasons
     - Fetches the transaction receipt via `eth_getTransactionReceipt`
     - Fetches the detailed trace via `debug_traceTransaction` with `callTracer`
   - Treat the command output as the canonical source of receipt and trace data.
2. **Fallback path (no shell access or user prefers manual):**
   - Ask the user to provide the **premium RPC URL** for that network (the same used in `.env` / Mongo / CI).
   - Use that RPC URL in the JSON-RPC calls below to fetch:
     - Transaction receipt via `eth_getTransactionReceipt`
     - Detailed trace via `debug_traceTransaction` with `callTracer`

**Reference Implementation:**
The `analyzeFailingTx` function in `script/playgroundHelpers.sh` shows the exact `cast` and `curl` commands to use. The analysis should use this helper when possible rather than requiring manual execution.

---

## DETAILED ANALYSIS STEPS

## STEP 1: FETCH TRANSACTION DATA

**AUTOMATED - DO THIS FIRST (USING PREMIUM RPC):**

1. **Confirm network and transaction:**

   - **User provides:** Transaction hash and network name (e.g. `arbitrum`, `polygon`, `mainnet`)
   - Optionally use `config/networks.json` **only for metadata** (chain ID, wrappedNative, etc.), **not** for RPC URLs unless the user explicitly authorizes using a public RPC.
   - If the network name is ambiguous or not found, list available networks from `config/networks.json` and ask the user to confirm or correct it.

2. **Preferred: Use local helper with premium RPC (when shell access is available):**

   - Propose running:

     ```bash
     bash -lc 'source script/helperFunctions.sh && source script/playgroundHelpers.sh && analyzeFailingTx "<NETWORK>" "<TX_HASH>"'
     ```

   - This will:
     - Resolve the **premium RPC URL** via `getRPCUrl "<NETWORK>"` (using `.env` / CI secrets)
     - Run `cast run` for an execution trace and revert info
     - Fetch the transaction receipt and debug trace
   - Use the command output as the canonical transaction receipt and trace data.

3. **Fallback: Manual JSON-RPC calls with user-provided premium RPC:**

   - If you cannot run the helper or the user prefers manual steps:
     - Ask the user for the **premium RPC URL** for the network.
     - Once provided, use that URL in the following calls.

4. **Fetch Transaction Receipt:**

   ```bash
   curl -X POST "$RPC_URL" \
     -H "Content-Type: application/json" \
     --data "{
       \"jsonrpc\":\"2.0\",
       \"method\":\"eth_getTransactionReceipt\",
       \"params\":[\"$TX_HASH\"],
       \"id\":1
     }"
   ```

   - Extract: status, gas used, logs, transaction details

5. **Fetch Detailed Trace:**

   ```bash
   curl -X POST "$RPC_URL" \
     -H "Content-Type: application/json" \
     --data "{
       \"jsonrpc\":\"2.0\",
       \"method\":\"debug_traceTransaction\",
       \"params\":[
         \"$TX_HASH\",
         {
           \"tracer\": \"callTracer\",
           \"timeout\": \"30s\"
         }
       ],
       \"id\":1
     }"
   ```

   - Extract: Complete execution trace with nested calls, value transfers, state changes

6. **Optional: Run cast run (if available):**
   ```bash
   cast run "$TX_HASH" --rpc-url "$RPC_URL"
   ```
   - Provides execution trace with revert reasons
   - Shows call stack and gas usage

**What to Extract from Fetched Data:**

- From receipt: Transaction status, `to` address, `from` address, `value`, gas used, event logs
- From trace: Complete execution flow, nested calls, value flow, all revert points
- From cast run (if available): Revert reasons, call stack

## STEP 2: TRANSACTION IDENTIFICATION

**CRITICAL - DO THIS FIRST:**

1. **Extract transaction details:**

   - Transaction hash
   - Network/chain ID
   - `to` address (target contract)
   - `from` address (user/sender)
   - Calldata (function selector + parameters)
   - `msg.value` (native value sent) - **VERIFY FROM TRANSACTION DETAILS, NOT TRACE**

2. **Identify if this is a LiFi transaction:**

   - Check if `to` address matches LiFiDiamond from `deployments/<network>.json`
   - If not direct call to LiFiDiamond, check if transaction eventually calls LiFiDiamond (indirect)
   - If LiFiDiamond is not involved at all, this is NOT one of our transactions

3. **Identify the network:**

   - Determine network name from chain ID
   - Load `deployments/<network>.json` to map all contract addresses

4. **Initial address enrichment:**
   - Check `deployments/<network>.json` for every address in the transaction
   - Replace addresses with contract names: `0x026F... → LiFiDiamond`
   - Note any addresses not found in deployments (external contracts)

## STEP 3: FACET & PROTOCOL IDENTIFICATION

1. **Identify the facet being used:**

   - From function selector, determine which facet function was called
   - Load the facet code from `src/Facets/<FacetName>.sol`
   - Understand the function signature and expected parameters

2. **Load facet configuration:**

   - **IMPORTANT**: Check the facet's deploy script (`script/deploy/facets/Deploy<FacetName>.s.sol`) to identify which config file it uses
   - Config file names don't always match facet names (e.g., GlacisFacet uses `glacis.json`, StargateFacetV2 uses `stargateV2.json`)
   - Look for `string.concat(root, "/config/<configFileName>.json")` in the deploy script's `getConstructorArgs()` function
   - Load the identified config file and map all external contract addresses to their names:
     - Routers, bridges, oracles, etc.
   - Note any network-specific addresses

3. **Decode calldata and parameters:**
   - Decode transaction calldata into human-readable format
   - Use `CalldataVerificationFacet` logic to decode calldata:
     - Extract BridgeData: `abi.decode(data[4:], (ILiFi.BridgeData))`
     - If hasSourceSwaps: `abi.decode(data[4:], (ILiFi.BridgeData, LibSwap.SwapData[]))`
   - Match parameters to the function signature
   - Identify struct types (BridgeData, SwapData, FacetData, etc.)
   - Use `extractMainParameters()` for quick parameter overview
   - **Map all addresses to names** from:
     - `deployments/<network>.json`
     - Facet config files
     - `config/whitelist.json` (for DEX addresses)
     - `config/networks.json` (for wrappedNative, etc.)

## STEP 4: PARAMETER DECODING & ENRICHMENT

### 3.1 BridgeData Parameters

Extract and display:

- `transactionId`
- `bridge` (protocol name)
- `integrator`
- `sendingAssetId` (token address - enrich with symbol if known)
- `receivingAssetId` (if applicable)
- `receiver` (destination address)
- `destinationChainId`
- `minAmount`
- `hasSourceSwaps`
- `hasDestinationCall`

### 3.2 SwapData Parameters

For each swap in the array, extract:

- `callTo` - **ENRICH**: Check `config/whitelist.json` to identify DEX name (see DEX Enrichment Algorithm below)
- `approveTo` - Address receiving approval (also enrich if it's a known DEX/router)
- `sendingAssetId` - Token being swapped from
- `receivingAssetId` - Token being swapped to
- `fromAmount` - Amount being swapped
- `callData` - Decode function selector and parameters
  - **ENRICH**: Match function selector in `config/whitelist.json` to get function name
- `requiresDeposit` - Whether tokens need to be pulled first

**Contract Name Enrichment Algorithm from whitelist.json (MANDATORY):**

For every address that appears as `callTo` or `approveTo` in SwapData, or any contract address in the transaction, you MUST:

1. **Search `config/whitelist.json` structure (check both DEXS and PERIPHERY):**

   **Step 1a: Check DEXS section:**

   - Navigate to `DEXS[]` array (top-level)
   - For each DEX entry in the array:
     - Check `contracts[<network>]` where `<network>` is the transaction network (e.g., "base", "mainnet", "arbitrum")
     - In that network's contract array, search for a contract object where `address` matches (case-insensitive)
     - If found, use the DEX's `name` field (e.g., "OKX Dex Aggregator", "Uniswap V3", "1inch")

   **Step 1b: Check PERIPHERY section (if not found in DEXS):**

   - Navigate to `PERIPHERY[<network>]` array where `<network>` matches the transaction network
   - Search for an object where `address` matches (case-insensitive)
   - If found, use the `name` field (e.g., "FeeCollector", "LiFiDEXAggregator", "TokenWrapper", "GasZipPeriphery")

2. **Case-insensitive address matching:**

   - Convert both the address from the transaction and addresses in whitelist.json to lowercase before comparison
   - Example: `0x2bD541Ab3b704F7d4c9DFf79EfaDeaa85EC034f1` should match `0x2bd541ab3b704f7d4c9dff79efadeaa85ec034f1`

3. **Function selector enrichment:**

   - Once the contract is found (in either DEXS or PERIPHERY), check the `functions` or `selectors` object in that entry
   - Match the function selector from `callData` to get the function signature
   - Example: `0x840c307f` → `"dagSwapTo(...)"` or `0xeedd56e1` → `"collectTokenFees(...)"`

4. **Fallback priority:**
   - If address is not found in whitelist.json (neither DEXS nor PERIPHERY), check `deployments/<network>.json` (might be a LiFi contract)
   - If still not found, use the address as-is but note it's an unknown external contract

**Examples:**

- Address: `0x2bD541Ab3b704F7d4c9DFf79EfaDeaa85EC034f1` on Base

  - Search: `whitelist.json` → `DEXS[]` → Find "OKX Dex Aggregator" → `contracts.base[]` → Match address
  - Result: **"OKX Dex Aggregator"** (NOT "DexRouter" or just the address)

- Address: `0x0A6d96E7f4D7b96CFE42185DF61E64d255c12DFf` on Base
  - Search: `whitelist.json` → `DEXS[]` → Not found → `PERIPHERY.base[]` → Match address
  - Result: **"FeeCollector"** (NOT "FeeCollectorContract" or just the address)

**SwapData Interpretation:**

- Identify which DEX/router is being called (use enriched DEX name, not generic terms)
- Understand what the swap is doing (token A → token B)
- Check if multiple swaps are chained
- Verify swap amounts and slippage parameters

### 3.3 ERC20 Token Name Enrichment

For addresses that appear to be **token contracts** (e.g. used as `sendingAssetId` / `receivingAssetId` or as ERC20-like transfer/approve targets), you may:

- Call the ERC20-standard `name()` view function on-chain using the **same premium RPC** already approved for this analysis, to enrich token names.
- Treat failures (non-ERC20 contracts, reverts, missing `name()`, malformed return data) as **non-fatal** and fall back to existing metadata (symbol/address).

### 3.4 Facet-Specific Data

Extract facet-specific parameters (e.g., GlacisData, StargateData, etc.):

- Map each field to its meaning
- Identify any native fee requirements
- Note any address parameters and enrich them

## STEP 5: EXECUTION TRACE ANALYSIS

**Analyze the fetched trace step-by-step from root to failure:**

**If using analyzeFailingTx:**

- Run the helper function to get structured trace output
- Extract revert reasons from `cast run` output
- Use receipt to verify transaction status and gas usage
- Parse detailed trace for complete execution flow

1. **Entry Point:**

   - Which function was called on which contract?
   - What were the input parameters?

2. **Call Stack:**

   - Trace each nested call in order
   - For each call, identify:
     - Caller contract (enriched name)
     - Target contract (enriched name)
     - Function being called
     - Value being sent (if any)
     - Parameters being passed
     - Whether call succeeded or failed

3. **Value Flow:**

   - Track native value through the execution
   - Note where value is consumed (swaps, fees, etc.)
   - **CRITICAL**: If root transaction had 0 value, contract cannot send value
   - Verify if value is sufficient at each step

4. **Token Flow:**

   - Track token deposits, approvals, transfers
   - Note balances at each step
   - Identify where tokens are held

5. **Failure Point(s):**
   - Identify ALL calls that failed (there may be multiple reverts)
   - For each failure, extract:
     - The exact call that failed
     - The error message
     - The contract state at failure point
     - Why that specific call failed
   - If multiple failures, analyze them in order of occurrence

## STEP 6: CODE VERIFICATION

1. **Check contract code:**

   - Read the facet code that was executing
   - Understand what the code expects
   - Compare expectations vs. what was provided

2. **Verify requirements:**

   - Check if native value requirements are met
   - Verify token approvals are sufficient
   - Confirm balances are adequate
   - Validate parameter ranges

3. **Identify mismatches:**
   - What was expected vs. what was provided
   - Where the mismatch occurred
   - Why it caused the failure

## STEP 7: OUTPUT FORMAT

Provide analysis in this exact structure:

```markdown
# Transaction Analysis: [TX_HASH]

## Transaction Intent

[Clear one-sentence description of what this transaction was trying to do]

## Root Transaction Details

- **Network:** [network name]
- **From:** [user address]
- **To:** [contract name] ([address])
- **Function:** [function name] ([selector])
- **Value:** [native amount] [native symbol] - **CRITICAL: Verify this matches transaction details**
- **Status:** [Success/Fail]

## Parameters Decoded

### BridgeData

- Transaction ID: [id]
- Bridge Protocol: [protocol name]
- Integrator: [name]
- Sending Asset: [token symbol/address]
- Amount: [amount]
- Receiver: [address]
- Destination Chain: [chain name/ID]
- Has Source Swaps: [true/false]
- Has Destination Call: [true/false]

### SwapData (if applicable)

**Swap 1:**

- DEX: [DEX name from whitelist]
- From: [token symbol/address] ([amount])
- To: [token symbol/address]
- Router: [contract name] ([address])
- Function: [function name] ([selector])

[Repeat for each swap]

### Facet-Specific Data

[Facet name]Data:

- [Parameter 1]: [value]
- [Parameter 2]: [value]
- [Native Fee Required]: [amount] - **CRITICAL**
- [Other relevant parameters]

## Execution Flow

1. **[Step 1]:** [Description]

   - Caller: [contract name]
   - Target: [contract name]
   - Action: [what happened]
   - Result: [success/fail]

2. **[Step 2]:** [Description]
   ...

[N] **[FAILURE POINT]:** [Description]

- Caller: [contract name]
- Target: [contract name]
- Function: [function name]
- Error: [error message]
- Reason: [why it failed]

## Root Cause Analysis

**Primary Issue:** [One-sentence summary]

**Detailed Explanation:**

1. [What was expected]
2. [What was provided]
3. [Why it failed]
4. [What would be needed to succeed]

## Contract Addresses Reference

- LiFiDiamond: [address]
- [FacetName]: [address]
- [External Contract 1]: [address]
- [External Contract 2]: [address]
- [Token 1]: [address]
- [Token 2]: [address]

## Summary for Stakeholders

**Transaction Purpose:** [What user was trying to do]

**Failure Reason:** [Clear, non-technical explanation]

**Required Fix:** [What needs to change for success]

**Impact:** [Who/what is affected]
```

## CRITICAL RULES

1. **ALWAYS fetch transaction data first (receipt + trace) using premium RPC URLs** (via `analyzeFailingTx`/`getRPCUrl` or user-provided RPC), and **NEVER** silently fall back to public RPCs (including `config/networks.json.rpcUrl`) unless the user explicitly approves it.
2. **ALWAYS first identify if LiFiDiamond was called (directly or indirectly) - if not, this isn't our transaction**
3. **ALWAYS verify root transaction `msg.value` from transaction receipt, NOT from trace**
4. **ALWAYS enrich ALL addresses with contract names from available sources (deployments, configs, whitelist, network metadata)**
5. **ALWAYS check facet deploy script to find correct config file name - don't assume it matches facet name**
6. **ALWAYS identify contract names from `config/whitelist.json` for swap/periphery calls** - Use the Contract Name Enrichment Algorithm: check `DEXS[]` → `contracts[<network>]` first, then `PERIPHERY[<network>]` if not found, match address (case-insensitive) → use `name` field. Never use generic terms like "DexRouter" when a specific name is available. Example: `0x2bD541Ab3b704F7d4c9DFf79EfaDeaa85EC034f1` on Base → "OKX Dex Aggregator" (NOT "DexRouter").
7. **ALWAYS trace execution step-by-step, don't assume nested calls succeeded**
8. **ALWAYS verify native value flow - if root had 0 value, contract can't send value**
9. **ALWAYS check facet code to understand what parameters are expected**
10. **ALWAYS find ALL revert points in trace - there may be multiple failures**
11. **NEVER assume a call succeeded just because it appears in trace**
12. **NEVER assume value in nested calls came from original transaction**
13. **NEVER skip parameter decoding - show all relevant data**
14. **NEVER use generic terms for contracts** - Always use the specific name from whitelist.json (e.g., "OKX Dex Aggregator", "FeeCollector", "Uniswap V3", "1inch") instead of generic terms like "DexRouter", "Router", "DEX", or "Contract"

## QUALITY CHECKS

Before finalizing analysis, verify:

- [ ] Transaction receipt and trace fetched successfully (via `analyzeFailingTx` or premium RPC URL)
- [ ] Premium RPC URL obtained via `getRPCUrl`/environment or explicitly from user (no unintended use of public RPCs)
- [ ] LiFiDiamond involvement confirmed (direct or indirect)
- [ ] Root transaction value verified from transaction receipt
- [ ] All addresses enriched with contract names from all available sources
- [ ] Correct config file identified from facet deploy script
- [ ] All contract names identified from whitelist using Contract Name Enrichment Algorithm (check DEXS[] → contracts[network], then PERIPHERY[network] → address match, case-insensitive)
- [ ] All parameters decoded and displayed in human-readable format
- [ ] Execution flow traced completely from start to end
- [ ] ALL failure points identified (may be multiple)
- [ ] Root cause clearly explained for each failure
- [ ] Summary is clear for non-technical readers

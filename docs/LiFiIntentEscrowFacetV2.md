# LiFiIntentEscrowFacetV2

## How it works

LI.FI Intent Escrow uses a built-in escrow as a deposit mechanism for its intents. The LI.FI Intent Escrow Facet deposits into the Escrow Input Settler, which will release the deposited funds to the solver when the fill has been proven. The system is self-serve, with the facet wrapping the deposit logic to ensure the appropriate parameters are called for the user to receive their output.

V2 replaces V1's `outputAmount` field with a single backend-supplied scaling factor (`outputAmountMultiplier`). On both entrypoints the committed destination output is `inputAmount * outputAmountMultiplier / MULTIPLIER_BASE`. See "Output Amount Scaling" below.

```mermaid
graph LR;
    D{LiFiDiamond}-- DELEGATECALL --> LiFiIntentEscrowFacetV2;
    LiFiIntentEscrowFacetV2 -- CALL --> LIFI_INTENT_ESCROW_SETTLER;
    User -- Tokens --> D{LiFiDiamond}
    D -- Tokens --> LIFI_INTENT_ESCROW_SETTLER

    Solver -- CALL--> OutputSettler
    OutputSettler -- Tokens --> User

    OutputOracle -- STATICCALL --> OutputSettler

    OutputOracle -- Validation --> InputOracle
    Solver -- CALL --> LIFI_INTENT_ESCROW_SETTLER
    LIFI_INTENT_ESCROW_SETTLER -- STATICCALL --> InputOracle
    LIFI_INTENT_ESCROW_SETTLER -- Token --> Solver
```

## Public Methods

- `function startBridgeTokensViaLiFiIntentEscrowV2(BridgeData memory _bridgeData, LiFiIntentEscrowDataV2 calldata _lifiIntentData)`
  - Simply bridges tokens using LIFIIntent
- `function swapAndStartBridgeTokensViaLiFiIntentEscrowV2(BridgeData memory _bridgeData, LibSwap.SwapData[] calldata _swapData, LiFiIntentEscrowDataV2 calldata _lifiIntentData)`
  - Performs swap(s) before bridging tokens using LIFIIntent

## Destination Calls

The LI.FI intent facet supports destination swaps using the periphery contract `ReceiverOIF`.
Destination swaps require configuring `.dstCallReceiver` to an instance of `ReceiverOIF` and `.dstCallSwapData` as a list of SwapData. When `dstCallSwapData.length` > 0, the recipient will be replaced with `.dstCallReceiver` and instead encoded in data to be executed by `ReceiverOIF`. The `BridgeData.hasDestinationCall` flag must be set to `true`. `.dstCallReceiver` is not validated beyond being non-zero. If `.dstCallSwapData.length` > 0 and `.dstCallReceiver` is set to an address that accepts an OIF callback without being `ReceiverOIF`, funds may be lost.

## Relative and Absolute Deadlines

Starting with facet version **1.1.0**, both entrypoints resolve `fillDeadline`, `expires`, and the exclusivity deadline in a `0xe0` output context at transaction inclusion. `MAX_RELATIVE_PERIOD_SECONDS` is **31,536,000 seconds (365 days)**:

| Supplied value       | Resolved timestamp        |
| -------------------- | ------------------------- |
| Less than 31,536,000 | `block.timestamp + value` |
| At least 31,536,000  | Supplied value unchanged  |

The threshold itself is an absolute timestamp, not a one-year duration. Zero resolves to the inclusion timestamp. The origin settler rejects fill and expiry timestamps that have already arrived, so zero is not a useful fill or proof window. Zero exclusivity ends at inclusion; use an empty context for an order without exclusivity.

For example, `fillDeadline = 600`, `expires = 172800`, and exclusivity `60` give a 10-minute fill window, 2-day proof/claim window, and 1-minute exclusivity window from inclusion. A wallet or mempool delay does not shorten those windows. It does not refresh quoted prices or deadlines embedded in source or destination swap calldata.

Each value resolves independently, so absolute and relative fields may be mixed. The origin settler continues to enforce expiration and deadline ordering; the facet does not clamp or reorder deadlines. Relative timestamps are cast to `uint32` after addition; values exceeding `uint32.max` are truncated. Absolute timestamps are forwarded unchanged.

The resolved timestamps and context are part of the on-chain order identifier. Indexers, solvers, and status tracking must use the origin settler's emitted `Open` order rather than hash the unresolved quote inputs.

### Exclusivity encoding

Exclusive limit orders use exactly 37 packed bytes:

```text
0xe0 | exclusiveFor (bytes32) | exclusivityDeadline (uint32)
  1 byte       32 bytes                4 bytes
```

The facet preserves the tag and solver identifier, replacing only the final four bytes with the resolved timestamp. This is packed encoding, not `abi.encode`. A context beginning with `0xe0` with any other length reverts with `InvalidCallData()` before an order is opened. Empty contexts and other tags, including `0x01` and `0xe1` Dutch auctions, pass through byte-for-byte; their timestamps must still be absolute.

## Output Amount Scaling

On both entrypoints, the committed destination output is derived from the input amount and a single backend-supplied scaling factor against `MULTIPLIER_BASE` (`1e18`):

```
effectiveOutputAmount = inputAmount * outputAmountMultiplier / MULTIPLIER_BASE
```

On the non-swap path, `inputAmount` is `bridgeData.minAmount`. On the swap path, `inputAmount` is the realized swap output. This extends `AcrossFacetV4`'s `outputAmountMultiplier` mechanism to both entrypoints (AcrossV4 only applies the multiplier on the swap path and commits `outputAmount` directly on the non-swap path). Integrators must understand the following properties:

- **There is no `outputAmount` field.** The committed output is always `inputAmount * outputAmountMultiplier / MULTIPLIER_BASE`. A zero `outputAmountMultiplier` makes the committed output `0`, which reverts with `InvalidAmount`.
- **`minAmount` on the swap path is only the slippage floor.** `bridgeData.minAmount` is the worst-case swap output passed to `_depositAndSwap`; the swap guarantees `swapOutcome >= minAmount`. It does not affect the committed output beyond enforcing the floor.
- **The multiplier folds price ratio and decimals into one factor.** It is computed off-chain as `multiplierPercentage * 1e18 * 10^(outputDecimals - inputDecimals)`, so it accounts for the quoted price ratio and any difference between the input and output token decimals.
- **The result floors.** Integer division truncates toward zero (it may under-commit by dust).

The committed output is derived solely from the backend-supplied multiplier; always use LI.FI backend-generated calldata, which supplies a consistent `outputAmountMultiplier`.

### Assumption and limits (by design)

The constant multiplier models the input → output rate as proportional — a single rate, fixed at quote time and applied linearly to the input. This is an intentional design choice: the facet is deliberately pricing-agnostic and does not reconstruct fill economics on-chain.

A solver's true fillable rate is **never** strictly proportional. It also reflects fixed components like destination gas, and liquidity-dependent pricing that do not scale linearly with size. Pricing is owned entirely by the off-chain entity that sets `outputAmountMultiplier` per quote and it is up to that entity to capture those components.

Because the rate is fixed at quote time, the committed output diverges from quoted and actualised outputs when the actual input differs from the quoted input. This primarily arises on the swap path, where the input is the realized `swapOutcome`. On the non-swap path the multiplier is applied to `bridgeData.minAmount` and the only difference in output is caused by quote precision and flooring noted above.

- **Realized input below the quoted size** → Fixed costs become a relatively larger component of the intent and may cause an intent to become unprofitable to fill.
- **Realized input above the quoted size** → Liquidity costs become a relatively larger component of the intent and may cause an intent to become unprofitable to fill. However, for in-kind or stable swaps liquidity costs are negligible and decrease with input, thus this is a volatile assets concern.

## LIFIIntent Specific Parameters

The methods listed above take a variable labeled `_lifiIntentData`. This data is specific to LIFIIntent and is represented as the following struct type:

```solidity
/// @param dstCallReceiver If dstCallSwapData.length > 0, has to be provided as a deployment of `ReceiverOIF`. Otherwise ignored.
/// @param recipient The end recipient of the swap. If no calldata is included, will be a simple recipient, otherwise it will be encoded as the end destination for the swaps.
/// @param depositAndRefundAddress The deposit and claim registration will be made for. If any refund is made, it will be sent to this address
/// @param nonce OrderId mixer. Used within the intent system to generate unique orderIds for each user. Should not be reused for `depositAndRefundAddress`
/// @param expires Claim expiry: seconds from block.timestamp if below MAX_RELATIVE_PERIOD_SECONDS, otherwise an absolute Unix timestamp.
/// @param fillDeadline Fill deadline: seconds from block.timestamp if below MAX_RELATIVE_PERIOD_SECONDS, otherwise an absolute Unix timestamp.
/// @param inputOracle Address of the validation layer used on the input chain
/// @param outputOracle Address of the validation layer used on the output chain
/// @param outputSettler Address of the output settlement contract containing the fill logic
/// @param outputToken The desired destination token
/// @param outputAmountMultiplier Scaling factor against `MULTIPLIER_BASE` (1e18 = 100%). On both entrypoints the committed output is `inputAmount * outputAmountMultiplier / MULTIPLIER_BASE`, folding the quoted price ratio and any input/output decimal difference into one factor. Use only LI.FI backend-generated calldata.
/// @param dstCallSwapData List of swaps to be executed on the destination chain. Is called on dstCallReceiver. If empty no call is made.
/// @param outputContext Context for the outputSettler. A 0xe0 context must be exactly 37 packed bytes (bytes1 tag, bytes32 exclusive solver, uint32 exclusivity deadline); its deadline uses the same relative/absolute convention as fillDeadline. Other context types are forwarded unchanged.
struct LiFiIntentEscrowDataV2 {
  // Goes into StandardOrder.outputs.recipient if .dstCallSwapData.length > 0
  bytes32 dstCallReceiver;
  // Goes into StandardOrder.outputs.recipient if .dstCallSwapData.length == 0
  bytes32 recipient;
  /// BatchClaim
  address depositAndRefundAddress; // StandardOrder.user
  uint256 nonce; // StandardOrder.nonce
  uint32 expires; // StandardOrder.expiry
  uint32 fillDeadline; // StandardOrder.fillDeadline
  address inputOracle; // StandardOrder.inputOracle
  bytes32 outputOracle; // StandardOrder.outputs.oracle
  bytes32 outputSettler; // StandardOrder.outputs.settler
  bytes32 outputToken; // StandardOrder.outputs.token
  uint128 outputAmountMultiplier; // output scaling factor (both entrypoints)
  LibSwap.SwapData[] dstCallSwapData; // Goes into StandardOrder.outputs.callbackData
  bytes outputContext; // StandardOrder.outputs.context
}
```

## Swap Data

Some methods accept a `SwapData _swapData` parameter.

Swapping is performed by a swap specific library that expects an array of calldata to can be run on various DEXs (i.e. Uniswap) to make one or multiple swaps before performing another action.

The swap library can be found [here](../src/Libraries/LibSwap.sol).

## LiFi Data

Some methods accept a `BridgeData _bridgeData` parameter.

This parameter carries both operational and analytics data. Fields like `minAmount`, `sendingAssetId`, `receiver`, `hasSourceSwaps`, and `hasDestinationCall` directly control deposits, validation, and output amount calculation. The remaining fields (`transactionId`, `bridge`, `destinationChainId`, etc.) are used to emit events that we can later track and index in our subgraphs and provide data on how our contracts are being used. `BridgeData` and the events we can emit can be found [here](../src/Interfaces/ILiFi.sol).

This facet validates `BridgeData` with a custom modifier (`validateBridgeDataLiFiIntentEscrowV2`) rather than the shared `Validatable.validateBridgeData`. Validation is limited to enforcing a non-zero `receiver` and a non-zero `minAmount`; the same-network check (`destinationChainId == block.chainid`, which reverts with `CannotBridgeToSameNetwork` in the shared modifier) is intentionally not applied because same-chain intents are supported.

## Getting Sample Calls to interact with the Facet

In the following some sample calls are shown that allow you to retrieve a populated transaction that can be sent to our contract via your wallet.

All examples use our [/quote endpoint](https://apidocs.li.fi/reference/get_quote) to retrieve a quote which contains a `transactionRequest`. This request can directly be sent to your wallet to trigger the transaction.

The quote result looks like the following:

```javascript
const quoteResult = {
  id: '0x...', // quote id
  type: 'lifi', // the type of the quote (all lifi contract calls have the type "lifi")
  tool: 'LIFIIntent', // the bridge tool used for the transaction
  action: {}, // information about what is going to happen
  estimate: {}, // information about the estimated outcome of the call
  includedSteps: [], // steps that are executed by the contract as part of this transaction, e.g. a swap step and a cross step
  transactionRequest: {
    // the transaction that can be sent using a wallet
    data: '0x...',
    to: '0x...',
    value: '0x00',
    from: '{YOUR_WALLET_ADDRESS}',
    chainId: 100,
    gasLimit: '0x...',
    gasPrice: '0x...',
  },
}
```

A detailed explanation on how to use the /quote endpoint and how to trigger the transaction can be found [here](https://docs.li.fi/products/more-integration-options/li.fi-api/transferring-tokens-example).

**Hint**: Don't forget to replace `{YOUR_WALLET_ADDRESS}` with your real wallet address in the examples.

### Cross Only

To get a transaction for a transfer from 30 USDC.e on Avalanche to USDC on Binance you can execute the following request:

```shell
curl 'https://li.quest/v1/quote?fromChain=AVA&fromAmount=30000000&fromToken=USDC&toChain=BSC&toToken=USDC&slippage=0.03&allowBridges=LIFIIntent&fromAddress={YOUR_WALLET_ADDRESS}'
```

### Swap & Cross

To get a transaction for a transfer from 30 USDT on Avalanche to USDC on Binance you can execute the following request:

```shell
curl 'https://li.quest/v1/quote?fromChain=AVA&fromAmount=30000000&fromToken=USDT&toChain=BSC&toToken=USDC&slippage=0.03&allowBridges=LIFIIntent&fromAddress={YOUR_WALLET_ADDRESS}'
```

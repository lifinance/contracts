# LIFIIntent Facet V2

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
- `swapAndStartBridgeTokensViaLiFiIntentEscrowV2(BridgeData memory _bridgeData, LibSwap.SwapData[] calldata _swapData, LiFiIntentEscrowDataV2 calldata _lifiIntentData)`
  - Performs swap(s) before bridging tokens using LIFIIntent

## Destination Calls

The LI.FI intent facet supports destination swaps using the periphery contract `ReceiverOIF`.
Destination swaps require configuring `.dstCallReceiver` to an instance of `ReceiverOIF` and `dstCallSwapData` as a list of SwapData. When `dstCallSwapData.length` > 0, the recipient will be replaced with `.dstCallReceiver` and instead encoded in data to be executed by `ReceiverOIF`. The `BridgeData.hasDestinationCall` flag must be set to `true`.

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

The committed output is derived solely from the backend-supplied multiplier; always use LI.FI backend-generated calldata, which supplies a consistent `outputAmountMultiplier`. The receiver is still validated on-chain.

## LIFIIntent Specific Parameters

The methods listed above take a variable labeled `_lifiIntentData`. This data is specific to LIFIIntent and is represented as the following struct type:

```solidity
/// @param dstCallReceiver If dstCallSwapData.length > 0, has to be provided as a deployment of `ReceiverOIF`. Otherwise ignored.
/// @param recipient The end recipient of the swap. If no calldata is included, will be a simple recipient, otherwise it will be encoded as the end destination for the swaps.
/// @param depositAndRefundAddress The deposit and claim registration will be made for. If any refund is made, it will be sent to this address
/// @param nonce OrderId mixer. Used within the intent system to generate unique orderIds for each user. Should not be reused for `depositAndRefundAddress`
/// @param expires If the proof for the fill does not arrive before this time, the claim expires
/// @param fillDeadline The fill has to happen before this time
/// @param inputOracle Address of the validation layer used on the input chain
/// @param outputOracle Address of the validation layer used on the output chain
/// @param outputSettler Address of the output settlement contract containing the fill logic
/// @param outputToken The desired destination token
/// @param outputAmountMultiplier Scaling factor against `MULTIPLIER_BASE` (1e18 = 100%). On both entrypoints the committed output is `inputAmount * outputAmountMultiplier / MULTIPLIER_BASE`, folding the quoted price ratio and any input/output decimal difference into one factor. Use only LI.FI backend-generated calldata.
/// @param dstCallSwapData List of swaps to be executed on the destination chain. Is called on dstCallReceiver. If empty no call is made.
/// @param outputContext Context for the outputSettler to identify the order type
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

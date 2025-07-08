# LIFIIntent Facet

## How it works

Catlayst uses The Compact as a deposit mechanism for its intents. The Compact contains interfaces to deposit and register intents on behalf of someone else.

The LIFIIntent Faucet constructs the LIFIIntent witness and then sends the witness along with the typings to The Compact which will derive the assocaited claim and register it.

Once signed by an allocator (off-chain action), solvers can solve the order and take the proof to the chain of the deposit to claim the deposit.
```mermaid
graph LR;
    D{LiFiDiamond}-- DELEGATECALL --> LIFIIntentFacet;
    LIFIIntentFacet -- CALL --> C(COMPACT);

    Solver -- CALL -> C(outputSettler)
    C(outputSettler) -- Tokens -> User

    C(outputOracle) -- STATICCALL -> C(outputSettler)

    C(outputOracle) -- Validation -> C(LocalOracle)
    C(LIFI_INTENT_COMPACT_SETTLER) -- STATICCALL -> C(LocalOracle)
    C(LIFI_INTENT_COMPACT_SETTLER) -- CALL -> C(COMPACT)
```

## Public Methods

- `function startBridgeTokensViaLIFIIntent(BridgeData calldata _bridgeData, LIFIIntentData calldata _lifiIntentData)`
  - Simply bridges tokens using LIFIIntent
- `swapAndStartBridgeTokensViaLIFIIntent(BridgeData memory _bridgeData, LibSwap.SwapData[] calldata _swapData, LIFIIntentData memory _lifiIntentData)`
  - Performs swap(s) before bridging tokens using LIFIIntent

## LIFIIntent Specific Parameters

The methods listed above take a variable labeled `_lifiIntentData`. This data is specific to LIFIIntent and is represented as the following struct type:

```solidity
/// @param receiverAddress The destination account for the delivered assets and calldata.
/// @param inputAssetId Input token. The leftmost 12 bytes is the lockTag and the rightmost 20 is the address of the token which needs to be equal to the inputAssetId.
/// @param expectedClaimHash Security check. If provided, it needs to match the returned claim hash from TheCompact.
/// @param user The deposit and claim registration will be made in this user's name. Compact 6909 tokens will be minted for this user and if the intent fails to be filled the tokens will remain in this user's name.
/// @param expiry If the proof for the fill does not arrive before this time, the claim expires.
/// @param fillDeadline The fill has to happen before this time.
/// @param inputOracle Address of the validation layer used on the input chain.
/// @param outputOracle Address of the validation layer used on the output chain.
/// @param outputSettler Address of the output settlement contract containing the fill logic.
/// @param outputToken The desires destination token.
/// @param outputAmount The amount of the destired token.
/// @param outputCall Calldata to be executed after the token has been delivered. Is called on receiverAddress. if set to 0x / hex"" no call is made.
/// @param outputContext Context for the outputSettler to identify the order type.
/// @param broadcast Whether to broadcast the intent on-chain. Note that this incurs additional gas costs.
struct LIFIIntentData {
    bytes32 receiverAddress; // StandardOrder.outputs.recipient.
    /// BatchClaim
    uint256 inputAssetId; // StandardOrder.inputs[0]
    address user; // StandardOrder.user
    uint256 nonce; // StandardOrder.nonce
    uint32 expires; // StandardOrder.expiry
    // LIFIIntent Witness //
    uint32 fillDeadline; // StandardOrder.fillDeadline
    address inputOracle; // StandardOrder.localOracle
    // LIFIIntent Output //
    bytes32 outputOracle; // StandardOrder.outputs.oracle
    bytes32 outputSettler; // StandardOrder.outputs.settler
    bytes32 outputToken; // StandardOrder.outputs.token
    uint256 outputAmount; // StandardOrder.outputs.amount
    bytes outputCall; // StandardOrder.outputs.call
    bytes outputContext; // StandardOrder.outputs.context
    // Validation
    bytes32 expectedClaimHash;
    bool broadcast;
}
```

## Swap Data

Some methods accept a `SwapData _swapData` parameter.

Swapping is performed by a swap specific library that expects an array of calldata to can be run on various DEXs (i.e. Uniswap) to make one or multiple swaps before performing another action.

The swap library can be found [here](../src/Libraries/LibSwap.sol).

## LiFi Data

Some methods accept a `BridgeData _bridgeData` parameter.

This parameter is strictly for analytics purposes. It's used to emit events that we can later track and index in our subgraphs and provide data on how our contracts are being used. `BridgeData` and the events we can emit can be found [here](../src/Interfaces/ILiFi.sol).

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

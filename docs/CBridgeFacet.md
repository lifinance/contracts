# CBridge Facet

## How it works

The CBridge Facet works by forwarding CBridge specific calls to the [CBridge contract].
Supports various bridging types (e.g. xAsset bridge as well as xLiquidity bridge). For more info about these bridge types:
[cBridge Pool-Based Transfer / xLiquidity](https://cbridge-docs.celer.network/developer/cbridge-pool-based-transfer-xliquidity).
[cBridge Canonical Mapping Transfer / xAsset](https://cbridge-docs.celer.network/developer/cbridge-canonical-mapping-transfer-xasset).

```mermaid
graph LR;
    D{LiFiDiamond}-- DELEGATECALL -->CBridgeFacet;
    CBridgeFacet -- CALL --> C(CBridge)
```

## Public Methods

- `function startBridgeTokensViaCBridge(BridgeData calldata _bridgeData, CBridgeData calldata _cBridgeData)`
  - Simply bridges tokens using CBridge
- `function swapAndStartBridgeTokensViaCBridge( BridgeData memory _bridgeData, LibSwap.SwapData[] calldata _swapData, CBridgeData memory _cBridgeData)`
  - Performs swap(s) before bridging tokens using CBridge

## CBridge Specific Parameters

Some of the methods listed above take a variable labeled `_cBridgeData`. This data is specific to CBridge and is represented as the following struct type:

```solidity
/// @param maxSlippage The max slippage accepted, given as percentage in point (pip).
/// @param nonce A number input to guarantee uniqueness of transferId. Can be timestamp in practice.
/// @param callTo the address of the contract to be called at destination
/// @param callData the encoded calldata (bytes32 transactionId, LibSwap.SwapData[] memory swapData, address receiver, address refundAddress)
/// @param messageBusFee the fee to be paid to CBridge message bus for relaying the message
/// @param bridgeType defines the bridge operation type (must be one of the values of CBridge library MsgDataTypes.BridgeSendType)

struct CBridgeData {
  uint32 maxSlippage;
  uint64 nonce;
  bytes callTo;
  bytes callData;
  uint256 messageBusFee;
  MsgDataTypes.BridgeSendType bridgeType;
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
  tool: 'cbridge', // the bridge tool used for the transaction
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
curl 'https://li.quest/v1/quote?fromChain=AVA&fromAmount=30000000&fromToken=0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664&toChain=BSC&toToken=USDC&slippage=0.03&allowBridges=cbridge&fromAddress={YOUR_WALLET_ADDRESS}'
```

### Swap & Cross

To get a transaction for a transfer from 30 USDT on Avalanche to USDC on Binance you can execute the following request:

```shell
curl 'https://li.quest/v1/quote?fromChain=AVA&fromAmount=30000000&fromToken=USDT&toChain=BSC&toToken=USDC&slippage=0.03&allowBridges=cbridge&fromAddress={YOUR_WALLET_ADDRESS}'
```

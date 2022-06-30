# Polygon Bridge Facet

## How it works

The Polygon Bridge Facet works by forwarding Polygon PoS Bridge specific calls to Root Chain Manager [contract](https://static.matic.network/network/mainnet/v1/index.json). Polygon Bridge provides a scaling solution which is near-instant, low-cost, and quite flexible. There is no change to the circulating supply of your token when it crosses the bridge. Tokens that leave ethereum network are locked and the same number of tokens are minted on Polygon as a pegged token (1:1).

```mermaid
graph LR;
    D{LiFiDiamond}-- DELEGATECALL -->PolygonBridgeFacet;
    PolygonBridgeFacet -- Approve --> P(ERC20Predicate)
    PolygonBridgeFacet -- CALL --> M(Root Chain Manager)
```

## Public Methods

- `function startBridgeTokensViaPolygonBridge(LiFiData calldata _lifiData, BridgeData calldata _bridgeData)`
  - Simply bridges tokens using Polygon PoS Bridge
- `function swapAndStartBridgeTokensViaPolygonBridge(LiFiData calldata _lifiData, LibSwap.SwapData[] calldata _swapData, BridgeData calldata _bridgeData)`
  - Performs swap(s) before bridging tokens using Polygon PoS Bridge

## Polygon Bridge Specific Parameters

Some of the methods listed above take a variable labeled `_bridgeData`.

This data is specific to Polygon PoS Bridge and is represented as the following struct type:

```solidity
/**
 * @param assetId The contract address of the token being bridged.
 * @param amount The amount of tokens to bridge.
 * @param receiver The address of the token recipient after bridging.
 */
struct BridgeData {
  address assetId;
  uint256 amount;
  address receiver;
}

```

## Swap Data

Some methods accept a `SwapData _swapData` parameter.

Swapping is performed by a swap specific library that expects an array of calldata to can be run on variaous DEXs (i.e. Uniswap) to make one or multiple swaps before performing another action.

The swap library can be found [here](../src/Libraries/LibSwap.sol).

## LiFi Data

Some methods accept a `LiFiData _lifiData` parameter.

This parameter is strictly for analytics purposes. It's used to emit events that we can later track and index in our subgraphs and provide data on how our contracts are being used. `LiFiData` and the events we can emit can be found [here](../src/Interfaces/ILiFi.sol).

## Getting Sample Calls to interact with the Facet

In the following some sample calls are shown that allow you to retrieve a populated transaction that can be sent to our contract via your wallet.

All examples use our [/quote endpoint](https://apidocs.li.finance/reference/get_quote-1) to retrieve a quote which contains a `transactionRequest`. This request can directly be sent to your wallet to trigger the transaction.

The quote result looks like the following:

```javascript
const quoteResult = {
  id: '0x...', // quote id
  type: 'lifi', // the type of the quote (all lifi contract calls have the type "lifi")
  tool: 'hop', // the bridge tool used for the transaction
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

A detailed explanation on how to use the /quote endpoint and how to trigger the transaction can be found [here](https://apidocs.li.finance/reference/how-to-transfer-tokens).

**Hint**: Don't forget to replace `{YOUR_WALLET_ADDRESS}` with your real wallet address in the examples.

### Cross Only

To get a transaction for a transfer from 20 DAI on Ethereum to DAI on Polygon you can execute the following request:

```shell
curl 'https://li.quest/v1/quote?fromChain=ETH&fromAmount=20000000000000000000&fromToken=DAI&toChain=POL&toToken=DAI&slippage=0.03&allowBridges=polygon&fromAddress={YOUR_WALLET_ADDRESS}'
```

### Swap & Cross

To get a transaction for a transfer from 10 USDT on Ethereum to DAI on Polygon you can execute the following request:

```shell
curl 'https://li.quest/v1/quote?fromChain=ETH&fromAmount=10000000000000000000&fromToken=USDT&toChain=POL&toToken=DAI&slippage=0.03&allowBridges=polygon&fromAddress={YOUR_WALLET_ADDRESS}'
```

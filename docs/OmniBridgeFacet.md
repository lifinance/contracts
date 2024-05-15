# Omni Bridge Facet

## How it works

The Omni Bridge Facet works by forwarding OmniBridge specific calls to Omni Bridge [contract](https://etherscan.io/address/0x88ad09518695c6c3712ac10a214be5109a655671). OmniBridge bridges ERC20 tokens between Ethereum and Gnosis. OmniBridge is also available for bridging between Binance Smart Chain and Gnosis.

```mermaid
graph LR;
    D{LiFiDiamond}-- DELEGATECALL -->OmniBridgeFacet;
    OmniBridgeFacet -- CALL --> O(OmniBridge)
```

## Public Methods

- `function startBridgeTokensViaOmniBridge(BridgeData memory _bridgeData)`
  - Simply bridges tokens using Omni Native Bridge
- `function swapAndStartBridgeTokensViaOmniBridge(BridgeData memory _bridgeData, SwapData[] calldata _swapData)`
  - Performs swap(s) before bridging tokens using Omni Native Bridge

## Swap Data

Some methods accept a `SwapData _swapData` parameter.

Swapping is performed by a swap specific library that expects an array of calldata to can be run on various DEXs (i.e. Uniswap) to make one or multiple swaps before performing another action.

The swap library can be found [here](../src/Libraries/LibSwap.sol).

## LiFi Data

Some methods accept a `BridgeData _bridgeData` parameter.

This parameter is strictly for analytics purposes. It's used to emit events that we can later track and index in our subgraphs and provide data on how our contracts are being used. `BridgeData` and the events we can emit can be found [here](../src/Interfaces/ILiFi.sol).

## Getting Sample Calls to interact with the Facet

In the following some sample calls are shown that allow you to retrieve a populated transaction that can be sent to our contract via your wallet.

All examples use our [/quote endpoint](https://apidocs.li.finance/reference/get_quote-1) to retrieve a quote which contains a `transactionRequest`. This request can directly be sent to your wallet to trigger the transaction.

The quote result looks like the following:

```javascript
const quoteResult = {
  id: '0x...', // quote id
  type: 'lifi', // the type of the quote (all lifi contract calls have the type "lifi")
  tool: 'omni', // the bridge tool used for the transaction
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

To get a transaction for a transfer from 20 DAI on Ethereum to DAI on Gnosis you can execute the following request:

```shell
curl 'https://li.quest/v1/quote?fromChain=ETH&fromAmount=20000000000000000000&fromToken=DAI&toChain=DAI&toToken=DAI&slippage=0.03&allowBridges=Omni&fromAddress={YOUR_WALLET_ADDRESS}'
```

### Swap & Cross

To get a transaction for a transfer from 10 USDT on Ethereum to DAI on Gnosis you can execute the following request:

```shell
curl 'https://li.quest/v1/quote?fromChain=ETH&fromAmount=10000000&fromToken=USDT&toChain=DAI&toToken=DAI&slippage=0.03&allowBridges=Omni&fromAddress={YOUR_WALLET_ADDRESS}'
```

# Gravity Facet

## How it works

The Gravity Facet works by forwarding Gravity specific calls to the Gravity router contract which is called [Gravity.sol](https://github.com/Gravity-Bridge/Gravity-Bridge/blob/main/solidity/contracts/Gravity.sol). This contract will pull and lock tokens in the given amount and emit an event. This event will be noticed by a backend service that triggers the release on the destination chain. For more information about how Gravity bridge works please [click here](https://github.com/Gravity-Bridge/Gravity-Docs).

## Public Methods

- `function startBridgeTokensViaGravity(BridgeData memory _bridgeData, GravityData calldata _gravityData)`
  - Simply bridges tokens using Gravity
- `function swapAndStartBridgeTokensViaGravity( BridgeData memory _bridgeData, LibSwap.SwapData[] calldata _swapData, GravityData memory _gravityData)`
  - Performs one or multiple swap(s) and bridges tokens using Gravity

## Gravity Specific Parameters

Some of the methods listed above take a variable labeled `_gravityData`.

To populate `_gravityData` you will provide the address you are bridging to in string format. String format is used since Gravity can bridge to non-EVM networks and their address format may differ from the EVM address format.

This data is specific to Gravity and is represented as the following struct type:

```solidity
/// @param destinationAddress the address of the receiver on the destination chain (in string format for non-EVM compatibility)
struct GravityData {
  string destinationAddress;
}
```

## Swap Data

Some methods accept a `SwapData _swapData` parameter.

Swapping is performed by a swap specific library that expects an array of calldata to can be run on variaous DEXs (i.e. Uniswap) to make one or multiple swaps before performing another action.

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
  tool: 'gravity', // the bridge tool used for the transaction
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

To get a transaction for a transfer from 20 DAI on Polygon to DAI on Fantom you can execute the following request:

```shell
curl 'https://li.quest/v1/quote?fromChain=POL&fromAmount=20000000000000000000&fromToken=POL&toChain=FTM&toToken=DAI&slippage=0.03&allowBridges=multichain&fromAddress={YOUR_WALLET_ADDRESS}'
```

### Swap & Cross

To get a transaction for a transfer from 10 MATIC on Polygon to DAI on Fantom you can execute the following request:

```shell
curl 'https://li.quest/v1/quote?fromChain=POL&fromAmount=10000000000000000000&fromToken=MATIC&toChain=FTM&toToken=DAI&slippage=0.03&allowBridges=multichain&fromAddress={YOUR_WALLET_ADDRESS}'
```

# Relay Facet

Relay is a cross-chain payments system enabling instant, low-cost bridging and cross-chain execution using relayers as financial agents.

## How it works

The Relay Facet works by sending funds directly to the RelayReceiver contract in the case of Native tokens or sending tokens directly
to the official Relay solver EOA along with extra calldata bytes that reference a prefecthed quote id

```mermaid
graph LR;
    D{LiFiDiamond}-- DELEGATECALL -->RelayFacet;
    RelayFacet -- CALL --> C(Relay)
```

## Public Methods

- `function startBridgeTokensViaRelay(BridgeData calldata _bridgeData, RelayData calldata _relayData)`
  - Simply bridges tokens using relay
- `swapAndStartBridgeTokensViaRelay(BridgeData memory _bridgeData, LibSwap.SwapData[] calldata _swapData, relayData memory _relayData)`
  - Performs swap(s) before bridging tokens using relay

## relay Specific Parameters

The methods listed above take a variable labeled `_relayData`. This data is specific to relay and is represented as the following struct type:

```solidity
/// @dev Relay specific parameters
/// @param requestId Realy API request ID
/// @param nonEVMReceiver set only if bridging to non-EVM chain
/// @params receivingAssetId address of receiving asset
/// @params callData calldata provided by Relay API
/// @params signature attestation signature provided by the Relay solver
struct RelayData {
  bytes32 requestId;
  bytes32 nonEVMReceiver;
  bytes32 receivingAssetId;
  bytes callData;
  bytes signature;
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
  tool: 'relay', // the bridge tool used for the transaction
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
curl 'https://li.quest/v1/quote?fromChain=AVA&fromAmount=30000000&fromToken=USDC&toChain=BSC&toToken=USDC&slippage=0.03&allowBridges=relay&fromAddress={YOUR_WALLET_ADDRESS}'
```

### Swap & Cross

To get a transaction for a transfer from 30 USDT on Avalanche to USDC on Binance you can execute the following request:

```shell
curl 'https://li.quest/v1/quote?fromChain=AVA&fromAmount=30000000&fromToken=USDT&toChain=BSC&toToken=USDC&slippage=0.03&allowBridges=relay&fromAddress={YOUR_WALLET_ADDRESS}'
```

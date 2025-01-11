# Circle Bridge Facet

## How it works

The Circle Bridge Facet works by forwarding Circle Bridge specific calls to Token Messenger [contract](https://github.com/circlefin/evm-cctp-contracts/blob/master/src/TokenMessenger.sol). Cross-Chain Transfer Protocol (CCTP) is a permissionless on-chain utility that can burn native USDC on a source chain, and mint native USDC of the same amount on a destination chain.

```mermaid
graph LR;
    D{LiFiDiamond}-- DELEGATECALL -->CircleBridgeFacet;
    CircleBridgeFacet -- CALL --> M(Token Messenger)
```

## Public Methods

- `function startBridgeTokensViaCircleBridge(BridgeData calldata _bridgeData, CircleBridgeData calldata _circleBridgeData)`
  - Simply bridges tokens using Circle Bridge
- `function swapAndStartBridgeTokensViaCircleBridge(BridgeData memory _bridgeData, SwapData[] calldata _swapData, CircleBridgeData calldata _circleBridgeData)`
  - Performs swap(s) before bridging tokens using Circle Bridge

## Circle Bridge Specific Parameters

Some of the methods listed above take a variable labeled `_circleBridgeData`.

This data is specific to CircleBridgeFacet and is represented as the following struct type:

```solidity
/// @param dstDomain The CircleBridge-specific domainId of the destination chain
struct CircleBridgeData {
  uint32 dstDomain;
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

All examples use our [/quote endpoint](https://apidocs.li.finance/reference/get_quote-1) to retrieve a quote which contains a `transactionRequest`. This request can directly be sent to your wallet to trigger the transaction.

The quote result looks like the following:

```javascript
const quoteResult = {
  id: '0x...', // quote id
  type: 'lifi', // the type of the quote (all lifi contract calls have the type "lifi")
  tool: 'circle', // the bridge tool used for the transaction
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

To get a transaction for a transfer from 20 USDC on Ethereum to USDC on Avalanche you can execute the following request:

```shell
curl 'https://li.quest/v1/quote?fromChain=ETH&fromAmount=20000000&fromToken=USDC&toChain=AVA&toToken=USDC&slippage=0.03&allowBridges=circle&fromAddress={YOUR_WALLET_ADDRESS}'
```

### Swap & Cross

To get a transaction for a transfer from 10 USDT on Ethereum to USDC on Avalanche you can execute the following request:

```shell
curl 'https://li.quest/v1/quote?fromChain=ETH&fromAmount=10000000&fromToken=USDT&toChain=AVA&toToken=USDC&slippage=0.03&allowBridges=circle&fromAddress={YOUR_WALLET_ADDRESS}'
```

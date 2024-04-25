# Optimism Bridge Facet

## How it works

The Optimism Bridge Facet works by forwarding Optimism Bridge specific calls to Optimism Bridge [contract](https://github.com/ethereum-optimism/optimism/blob/master/packages/contracts/contracts/L1/messaging/L1StandardBridge.sol). The standard bridge functionality provides a method for an ERC20 token to be deposited and locked on L1 in exchange of the same amount of an equivalent token on L2.

```mermaid
graph LR;
    D{LiFiDiamond}-- DELEGATECALL -->OptimismBridgeFacet;
    OptimismBridgeFacet -- CALL --> O(OptimismBridge)
```

## Public Methods

- `function initOptimism(Config[] calldata configs, IL1StandardBridge standardBridge)`
  - Initializer method. Sets bridges for the specific assets and register standard bridge.
- `function registerOptimismBridge(address assetId, address bridge)`
  - Register method. Sets bridge for the specific asset.
- `function startBridgeTokensViaOptimismBridge(BridgeData memory _bridgeData, OptimismData calldata _optimismData)`
  - Simply bridges tokens using Optimism Native Bridge
- `function swapAndStartBridgeTokensViaOptimismBridge(BridgeData memory _bridgeData, SwapData[] calldata _swapData, OptimismData calldata _optimismData)`
  - Performs swap(s) before bridging tokens using Optimism Native Bridge

## Optimism Bridge Specific Parameters

Some of the methods listed above take a variable labeled `_optimismData`.

To populate `_optimismData` you need to get the `assetIdOnL2` and `bridge`.

- `assetIdOnL2`
  Address of token on L2.
  It can be get from the configuration.
  For native asset, it can be zero address.

This data is specific to Optimism Bridge and is represented as the following struct type:

```solidity
/// @param assetIdOnL2 The contract address of the token on L2.
/// @param l2Gas Gas limit required to complete the deposit on L2.
/// @param isSynthetix If the sending token is SNX.
struct OptimismData {
  address assetIdOnL2;
  uint32 l2Gas;
  bool isSynthetix;
}
```

**WARNING**: If the l2Gas is underpaid, the `finalizeDeposit` internal function call will fail and the funds will be lost!
Please make sure to pass enough gas if the Optimism facet is used directly.

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
  tool: 'optimism', // the bridge tool used for the transaction
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

To get a transaction for a transfer from 20 DAI on Ethereum to DAI on Optimism you can execute the following request:

```shell
curl 'https://li.quest/v1/quote?fromChain=ETH&fromAmount=20000000000000000000&fromToken=DAI&toChain=OPT&toToken=DAI&slippage=0.03&allowBridges=optimism&fromAddress={YOUR_WALLET_ADDRESS}'
```

### Swap & Cross

To get a transaction for a transfer from 10 USDT on Ethereum to DAI on Optimism you can execute the following request:

```shell
curl 'https://li.quest/v1/quote?fromChain=ETH&fromAmount=10000000&fromToken=USDT&toChain=OPT&toToken=DAI&slippage=0.03&allowBridges=optimism&fromAddress={YOUR_WALLET_ADDRESS}'
```

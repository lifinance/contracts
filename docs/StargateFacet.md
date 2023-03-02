# Stargate Facet

## How it works

The Stargate Facet works by forwarding Stargate specific calls to a token specific [router contract](https://stargateprotocol.gitbook.io/stargate/developers/how-to-swap). Stargate is a community-driven organization building the first fully composable native asset bridge, and the first dApp built on LayerZero. Stargate's vision is to make cross-chain liquidity transfer a seamless, single transaction process. Stargate is the first bridge to solve the [bridging trilemma](https://www.dropbox.com/s/gf3606jedromp61/Delta-Solving.The.Bridging-Trilemma.pdf).

```mermaid
graph LR;
    D{LiFiDiamond}-- DELEGATECALL -->A[StargateFacet]
    A -- CALL --> USDC(StargateRouter)
```

## Public Methods

- `function initStargate(PoolIdConfig[] calldata poolIdConfigs, ChainIdConfig[] calldata chainIdConfigs)`
  - Initializer method. Sets pool ids for the specific assets and layerzero chain ids for chains.
- `function startBridgeTokensViaStargate(BridgeData calldata _bridgeData, StargateData calldata _stargateData)`
  - Simply bridges tokens using Stargate
- `function swapAndStartBridgeTokensViaStargate(BridgeData memory _bridgeData, LibSwap.SwapData[] calldata _swapData, StargateData calldata _stargateData)`
  - Performs swap(s) before bridging tokens using Stargate
- `function quoteLayerZeroFee(uint256 _destinationChainId, StargateData calldata _stargateData)`
  - Returns a required amount for native gass fee

You need to send native gas fee that the Stargate needs to pay for the cross chain message.
To get the [Cross Chain Swap Fee](https://stargateprotocol.gitbook.io/stargate/developers/cross-chain-swap-fee), you can simply call `quoteLayerZeroFee` of StargateFacet contract with `_stargateData`.

## Stargate Specific Parameters

Some of the methods listed above take a variable labeled `_stargateData`.

To populate `_stargateData` you will need to get the chain ID and pool ID you are bridging from. You can visit the [LayerZero Chain IDs](https://stargateprotocol.gitbook.io/stargate/developers/contract-addresses/mainnet) and [Pool IDs](https://stargateprotocol.gitbook.io/stargate/developers/pool-ids) to get the list.

This data is specific to Stargate and is represented as the following struct type:

```solidity
/// @param dstPoolId Dest pool id.
/// @param minAmountLD The min qty you would accept on the destination.
/// @param dstGasForCall Additional gas fee for extral call on the destination.
/// @param refundAddress Refund adddress. Extra gas (if any) is returned to this address
/// @param lzFee Estimated message fee.
/// @param callTo The address to send the tokens to on the destination.
/// @param callData Additional payload.
struct StargateData {
  uint256 dstPoolId;
  uint256 minAmountLD;
  uint256 dstGasForCall;
  uint256 lzFee;
  address payable refundAddress;
  bytes callTo;
  bytes callData;
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

All examples use our [/quote endpoint](https://apidocs.li.finance/reference/get_quote-1) to retrieve a quote which contains a `transactionRequest`. This request can directly be sent to your wallet to trigger the transaction.

The quote result looks like the following:

```javascript
const quoteResult = {
  id: '0x...', // quote id
  type: 'lifi', // the type of the quote (all lifi contract calls have the type "lifi")
  tool: 'stargate', // the bridge tool used for the transaction
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

To get a transaction for a transfer from 20 USDC on Polygon to USDC on Fantom you can execute the following request:

```shell
curl 'https://li.quest/v1/quote?fromChain=POL&fromAmount=20000000&fromToken=USDC&toChain=FTM&toToken=USDC&slippage=0.03&allowBridges=stargate&fromAddress={YOUR_WALLET_ADDRESS}'
```

### Swap & Cross

To get a transaction for a transfer from 10 USDT on Polygon to USDC on Fantom you can execute the following request:

```shell
curl 'https://li.quest/v1/quote?fromChain=POL&fromAmount=10000000&fromToken=USDT&toChain=FTM&toToken=USDC&slippage=0.03&allowBridges=stargate&fromAddress={YOUR_WALLET_ADDRESS}'
```

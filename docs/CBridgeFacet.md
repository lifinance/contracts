# CBridge Facet

## How it works

The CBridge Facet works by forwarding CBridge specific calls to the [CBridge contract](https://github.com/celer-network/sgn-v2-contracts/blob/main/contracts/Bridge.sol). All bridging is done by calling the `send` method or `sendNative` method if you using a native token like **ETH** or **MATIC**.

```mermaid
graph LR;
    D{LiFiDiamond}-- DELEGATECALL -->CBridgeFacet;
    CBridgeFacet -- CALL --> C(CBridge)
```

## Public Methods

- `function initCbridge(address _cBridge, uint64 _chainId)`
  - Initializer method. Sets chainId and CBridge contract for the specific chain
- `function startBridgeTokensViaCBridge(LiFiData memory _lifiData, CBridgeData calldata _cBridgeData)`
  - Simply bridges tokens using CBridge
- `function swapAndStartBridgeTokensViaCBridge( LiFiData memory _lifiData, LibSwap.SwapData[] calldata _swapData, CBridgeData memory _cBridgeData)`
  - Performs swap(s) before bridging tokens using CBridge

## CBridge Specific Parameters

Some of the methods listed above take a variable labeled `_cBridgeData`. This data is specific to CBridge and is represented as the following struct type:

```solidity
/**
 * @param receiver The address of the token recipient after bridging.
 * @param token The contract address of the token being bridged.
 * @param amount The amount of tokens to bridge.
 * @param dstChainId The chainId of the chain to bridge to.
 * @param nonce Unique number used for this specific bridging TX.
 * @param maxSlippage The maximum slippage in percent tolerated for bridging.
 */
struct CBridgeData {
  address receiver;
  address token;
  uint256 amount;
  uint64 dstChainId;
  uint64 nonce;
  uint32 maxSlippage;
}

```

## Swap Data

Some methods accept a `SwapData _swapData` parameter.

Swapping is performed by a swap specific library that expects an array of calldata to can be run on variaous DEXs (i.e. Uniswap) to make one or multiple swaps before performing another action.

The swap library can be found [here](../src/Libraries/LibSwap.sol).

## LiFi Data

Some methods accept a `LiFiData _lifiData` parameter.

This parameter is strictly for analytics purposes. It's used to emit events that we can later track and index in our subgraphs and provide data on how our contracts are being used. `LiFiData` and the events we can emit can be found [here](../src/Interfaces/ILiFi.sol).

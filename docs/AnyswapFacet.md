# Anyswap Facet

## How it works

The Hop Facet works by forwarding Anyswap specific calls to a token specific [router contract](https://github.com/anyswap/anyswap-v1-core/blob/master/contracts/AnyswapV5Router.sol). Anyswap works by locking tokens into a router contract on a base chain before bridging. Tokens can then be minted by a router contract on the receiving chain. This is handled by a decentralized network of [MPC nodes](https://docs.multichain.org/how-it-works) under the hood.

```mermaid
graph LR;
    D{LiFiDiamond}-- DELEGATECALL -->A[AnyswapFacet]
    A -- CALL --> USDC(USDC Router)
    A -- CALL --> DAI(DAI Router)
    A -- CALL --> WETH(WETH Router)
```

## Public Methods

- `function startBridgeTokensViaAnyswap(LiFiData memory _lifiData, AnyswapData calldata _anyswapData)`
  - Simply bridges tokens using Anyswap
- `function swapAndStartBridgeTokensViaAnyswap( LiFiData memory _lifiData, LibSwap.SwapData[] calldata _swapData, AnyswapData memory _anyswapData)`
  - Performs swap(s) before bridging tokens using Anyswap

## Anyswap Specific Parameters

Some of the methods listed above take a variable labeled `_anyswapData`.

To populate `_anyswapData` you will need to fetch the router address for the chain ID you are bridging from. You can use the [Anyswap API](https://github.com/anyswap/CrossChain-Router/wiki/How-to-integrate-AnySwap-Router) to do this.

This data is specific to Anyswap and is represented as the following struct type:

```solidity
/**
 * @param token Address of the contract for the token being bridged.
 * @param router Address of the router contract for the token being bridged.
 * @param amount Amount of the token being bridged.
 * @param recipient Recipient address
 * @param chainId Chain ID of the chain to bridge tokens to
 */
struct AnyswapData {
  address token;
  address router;
  uint256 amount;
  address recipient;
  uint256 toChainId;
}

```

## Swap Data

Some methods accept a `SwapData _swapData` parameter.

Swapping is performed by a swap specific library that expects an array of calldata to can be run on variaous DEXs (i.e. Uniswap) to make one or multiple swaps before performing another action.

The swap library can be found [here](../src/Libraries/LibSwap.sol).

## LiFi Data

Some methods accept a `LiFiData _lifiData` parameter.

This parameter is strictly for analytics purposes. It's used to emit events that we can later track and index in our subgraphs and provide data on how our contracts are being used. `LiFiData` and the events we can emit can be found [here](../src/Interfaces/ILiFi.sol).

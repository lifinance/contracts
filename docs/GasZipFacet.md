# GasZipFacet

## Description

The GasZipFacet offers functionality to send native gas tokens to other chains using the Gas.Zip protocol (https://www.gas.zip/)
If gas is sent to several chains, each chain will receive an equal amount

## How To Use

### Functions for bridging

- `function startBridgeTokensViaGasZip(BridgeData memory _bridgeData, GasZipData calldata _gasZipData)`
  - Simply deposits native tokens to Gas.zip protocol (this function can only be used for native tokens)
- `function swapAndStartBridgeTokensViaGasZip(BridgeData memory _bridgeData, SwapData[] calldata _swapData, GasZipData calldata _gasZipData)`
  - Performs swap(s) from ERC20 to native before depositing to Gas.zip protocol. The last receiving token must be native.

## Bridge Specific Parameters

Some of the methods listed above take a variable labeled `_gasZipData`.

This data is specific to Gas.Zip and is represented as the following struct type:

```solidity
/// @param destinationChains a value that represents a list of chains to which gas should be distributed (see https://dev.gas.zip/gas/code-examples/deposit for more details)
/// @param receiver the address to receive the gas on dst chain
struct GasZipData {
  uint256 destinationChains;
  address receiver;
}
```

## Swap Data

Some methods accept a `SwapData _swapData` parameter.

Swapping is performed by a swap specific library that expects an array of calldata to can be run on various DEXs (i.e. Uniswap) to make one or multiple swaps before performing another action.

The swap library can be found [here](../src/Libraries/LibSwap.sol).

## LiFi Data

Most of the methods accept a `BridgeData _bridgeData` parameter.

The facet uses the `destinationChainId` parameter to determine which chain to send gas to.
It will send the `minAmount` to this chain (or convert it to native before in case of ERC20).
The funds will be sent to the `receiver` address.

The `_bridgeData` also used to emit events that we can later track and index in our subgraphs and provide data on how our contracts are being used. `BridgeData` and the events we can emit can be found [here](../src/Interfaces/ILiFi.sol).

# GasZipFacet

## Description

The GasZipFacet offers functionality to send native gas tokens to another chain using the Gas.Zip protocol (https://www.gas.zip/)
It can be used as a regular bridge facet or as a (LibSwap.SwapData) swap step.

If used as a regular bridge facet, it will either execute one or more swap steps prior to bridging, or bridge directly.
If used as a swap step, it can be combined with any other bridge as a prior step before bridging.
This allows for maximum flexibility when it comes to sending gas to another chain.

## How To Use

### Functions for bridging

- `function startBridgeTokensViaGasZip(BridgeData memory _bridgeData, GasZipData calldata _gasZipData)`
  - Simply bridges tokens using GasZipFacet (can only be used for native tokens)
- `function swapAndStartBridgeTokensViaGasZip(BridgeData memory _bridgeData, SwapData[] calldata _swapData, GasZipData calldata _gasZipData)`
  - Performs swap(s) before bridging tokens using GasZipFacet

### Functions for using this facet as a LibSwap.SwapData step

The contract provides two public methods:
One for ERC20 tokens (these will be swapped into native before depositing to gas.zip)

```solidity
/// @notice Swaps ERC20 tokens to native and deposits these native tokens in the GasZip router contract
/// @param _swapData The swap data struct
/// @param _destinationChainId the id of the chain where gas should be made available
/// @param _recipient the address to receive the gas on dst chain
function depositToGasZipERC20(
    LibSwap.SwapData calldata _swapData,
    uint256 _destinationChainId,
    address _recipient
)
```

and another for native tokens (these will be directly deposited)

```solidity
/// @notice Deposits native tokens in the GasZip router contract
/// @param _amountToZip The swap data struct
/// @param _destinationChainId the id of the chain where gas should be made available
/// @param _recipient the address to receive the gas on dst chain
function depositToGasZipNative(
    uint256 _amountToZip,
    uint256 _destinationChainId,
    address _recipient
)
```

## Bridge Specific Parameters

Some of the methods listed above take a variable labeled `_gasZipData`.

This data is specific to Gas.Zip and is represented as the following struct type:

```solidity
/// @param gasZipSwapData (only required for ERC20 tokens): the swapData that swaps from ERC20 to native before depositing to gas.zip
/// @param amountOutMin (only required for ERC20 tokens): the native amount we expect to receive from swap and plan to deposit to gas.zip
struct GasZipData {
  LibSwap.SwapData gasZipSwapData;
  uint256 amountOutMin;
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

# GasZipPeriphery

## Description

The GasZipPeriphery contract offers functionality to send native gas tokens to other chains using the Gas.Zip protocol (https://www.gas.zip/)
It can be used as (LibSwap.SwapData) swap step prior to bridging.

## How To Use

### Functions for using this facet as a LibSwap.SwapData step

The contract provides two public methods:
One for ERC20 tokens (these will be swapped into native before depositing to Gas.zip using the LiFiDEXAggregator)

```solidity
/// @notice Swaps ERC20 tokens to native and deposits these native tokens in the GasZip router contract
///         Swaps are only allowed via the LiFiDEXAggregator
/// @dev this function can be used as a LibSwap.SwapData protocol step to combine it with any other bridge
/// @param _swapData The swap data that executes the swap from ERC20 to native
/// @param _gasZipData contains information about which address should receive gas on which chains
function depositToGasZipERC20(
    LibSwap.SwapData calldata _swapData,
    IGasZip.GasZipData calldata _gasZipData
)
```

and another for native tokens (these will be directly deposited)

```solidity
/// @notice Deposits native tokens to the GasZip router contract
/// @dev this function can be used as a LibSwap.SwapData protocol step to combine it with any other bridge
/// @param _gasZipData contains information about which address should receive gas on which chains
function depositToGasZipNative(
    IGasZip.GasZipData calldata _gasZipData
)
```

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

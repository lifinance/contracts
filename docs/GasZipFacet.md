# GasZipFacet

## Description

The GasZipFacet provides function to deposit ERC20 and native tokens to the Gas.zip protocol (https://www.gas.zip/)

## How To Use

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

and another for Native tokens (these will be directly deposited)

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

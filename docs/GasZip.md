# GasZip

## Description

Periphery contract used for sending gas on requested chain.

## How To Use

The contract is meant to be used to call the GasZip routers which will execute the refueling part.

There are two methods.
One for ERC20 tokens

```solidity
/// @notice Refuel the gas on the requested chain from ERC20 token
/// @param _swap data needed for swap before the router call
/// @param destinationChain native token will be received on this chain
/// @param recipient address that will receive tokens in the end
function zipERC20(
    SwapData calldata _swap,
    uint256 destinationChain,
    address recipient
)
```

and another for Native tokens (here no swap before the router call will be performed)

```solidity
/// @notice Refuel the gas on the requested chain from native token
/// @param amountToZip amount of sending token
/// @param destinationChain native token will be received on this chain
/// @param recipient address that will receive tokens in the end
function zipERC20(
    uint256 amountToZip,
    uint256 destinationChain,
    address recipient
)
```

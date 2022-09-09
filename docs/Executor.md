# Executor

## Description

Periphery contract used for aribitrary cross-chain and same chain execution, swaps and transfers

## How To Use

The contract has a number of methods that can be called depending on the context of the transaction
and which third-party integration is being used.

The following methods are available:

This method is used to execute transactions received by the Stargate Router

```solidity
/// @notice Completes a cross-chain transaction on the receiving chain.
/// @dev This function is called from Stargate Router.
/// @param * (unused) The remote chainId sending the tokens
/// @param * (unused) The remote Bridge address
/// @param * (unused) Nonce
/// @param * (unused) The token contract on the local chain
/// @param * (unused) The amount of local _token contract tokens
/// @param _payload The data to execute
function sgReceive(
    uint16, // _srcChainId unused
    bytes memory, // _srcAddress unused
    uint256, // _nonce unused
    address, // _token unused
    uint256, // _amountLD unused
    bytes memory _payload
)
```

This method is used to execute transactions received by Connext

```solidity
/// @notice Performs a swap before completing a cross-chain transaction
/// @param _lifiData data used purely for tracking and analytics
/// @param _swapData array of data needed for swaps
/// @param transferredAssetId token received from the other chain
/// @param receiver address that will receive tokens in the end
function swapAndCompleteBridgeTokens(
    LiFiData calldata _lifiData,
    LibSwap.SwapData[] calldata _swapData,
    address transferredAssetId,
    address payable receiver
)
```

This method is meant to be called as part of a single chain transaction. It allows
a user to make any number of swaps or arbitrary contract calls.

```solidity
/// @notice Performs a series of swaps or arbitrary executions
/// @param _lifiData data used purely for tracking and analytics
/// @param _swapData array of data needed for swaps
/// @param transferredAssetId token received from the other chain
/// @param receiver address that will receive tokens in the end
function swapAndExecute(
    LiFiData calldata _lifiData,
    LibSwap.SwapData[] calldata _swapData,
    address transferredAssetId,
    address payable receiver,
    uint256 amount
)
```

The contract also has a number of utility methods that are self-explanatory

```solidity
/// @notice set Stargate Router
/// @param _router the Stargate router address
function setStargateRouter(address _router)

/// @notice set ERC20 Proxy
/// @param _erc20Proxy the address of the ERC20Proxy contract
function setERC20Proxy(address _erc20Proxy)
```

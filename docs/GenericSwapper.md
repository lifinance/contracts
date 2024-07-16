# GenericSwapper

## Description

Gas-optimized periphery contract used for executing same-chain swaps (incl. an optional fee collection step)

## How To Use

This contract was designed to provide a heavily gas-optimized way to execute same-chain swaps. It will not emit any events and it can only use the LI.FI DEX Aggregator to execute these swaps. Other DEXs are not supported.
It will also not check if token approvals from the GenericSwapper to the LI.FI DEX Aggregator and to the FeeCollector exist. If such approvals are missing, they would have to be set first (see function below).

In order to still be able to trace transactions a `transactionId` will be appended to the calldata, separated from the actual calldata with a delimiter ('`0xdeadbeef`').

The contract has a number of specialized methods for various use cases:

This method is used to execute a single swap from ERC20 to ERC20

```solidity
    /// @notice Performs a single swap from an ERC20 token to another ERC20 token
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensSingleV3ERC20ToERC20(
        address _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData calldata _swapData
    )
```

This method is used to execute a single swap from ERC20 to native

```solidity
    /// @notice Performs a single swap from an ERC20 token to the network's native token
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensSingleV3ERC20ToNative(
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData calldata _swapData
    )
```

This method is used to execute a single swap from native to ERC20

```solidity
    /// @notice Performs a single swap from the network's native token to ERC20 token
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensSingleV3NativeToERC20(
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData calldata _swapData
    )
```

This method is used to execute a swap from ERC20 any other token (ERC20 or native) incl. a previous fee collection step

```solidity
    /// @notice Performs multiple swaps in one transaction, starting with ERC20 and ending with native
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensMultipleV3ERC20ToAny(
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData[] calldata _swapData
    )

```

This method is used to execute a swap from native to ERC20 incl. a previous fee collection step

```solidity
    /// @notice Performs multiple swaps in one transaction, starting with native and ending with ERC20
    /// @param _receiver the address to receive the swapped tokens into (also excess tokens)
    /// @param _minAmountOut the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensMultipleV3NativeToERC20(
        address payable _receiver,
        uint256 _minAmountOut,
        LibSwap.SwapData[] calldata _swapData
    )
```

This method is used to set max approvals between the GenericSwapper and the DEXAggregator as well as the FeeCollector
(it can only be called by the registered admin address)

```solidity
    /// @notice (Re-)Sets max approvals from this contract to DEX Aggregator and FeeCollector
    /// @param _approvals The information which approvals to set for which token
    function setApprovalForTokens(
        TokenApproval[] calldata _approvals
    )

```

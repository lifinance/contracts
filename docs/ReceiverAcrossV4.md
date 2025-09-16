# ReceiverAcrossV4

## Description

Periphery contract used for arbitrary cross-chain destination calls via AcrossV4. This contract is an updated version of ReceiverAcrossV3 with improved constructor validation, better error handling, and consistent naming conventions.

## Key Differences from V3

- **Constructor Validation**: Validates that all constructor parameters are non-zero addresses
- **Variable Naming**: Uses UPPERCASE for immutable variables (EXECUTOR, SPOKEPOOL)
- **Error Handling**: Uses `LibAsset.transferERC20` for more consistent token transfers
- **Function Name**: Currently uses `handleV3AcrossMessage` (same as V3) - this may be updated in future versions

## How To Use

The contract has one method which will (and can only) be called through the AcrossV4 Spokepool contract to execute arbitrary destination calldata:

```solidity
    /// @notice Completes an AcrossV4 cross-chain transaction on the receiving chain
    /// @dev Token transfer and message execution will happen in one atomic transaction
    /// @dev This function can only be called by the Across SpokePool on this network
    /// @dev Note: Function name is currently handleV3AcrossMessage (same as V3) for compatibility
    /// @param tokenSent The address of the token that was received
    /// @param amount The amount of tokens received
    /// @param relayer The address of the relayer who is executing this message (unused)
    /// @param message The composed message payload in bytes
    function handleV3AcrossMessage(
        address tokenSent,
        uint256 amount,
        address relayer,
        bytes memory message
    )
```

## Key Features

- **V4 Compatibility**: Updated to work with AcrossV4 protocol
- **Arbitrary Execution**: Supports cross-chain swaps and message passing
- **Security**: Only callable by the Across SpokePool contract
- **Error Handling**: Graceful fallback to direct token transfer if swap fails
- **Gas Optimization**: Efficient token approval management

## Constructor Parameters

- `_owner`: The owner address with withdrawal permissions
- `_executor`: The Executor contract address for swap execution
- `_spokepool`: The Across SpokePool contract address on this network

## Events

The contract emits `LiFiTransferRecovered` events when swap execution fails and tokens are sent directly to the receiver.

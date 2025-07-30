# ReceiverAcrossV4

## Description

Periphery contract used for arbitrary cross-chain destination calls via AcrossV4

## How To Use

The contract has one method which will (and can only) be called through the AcrossV4 Spokepool contract to execute arbitrary destination calldata:

```solidity
    /// @notice Completes an AcrossV4 cross-chain transaction on the receiving chain
    /// @dev Token transfer and message execution will happen in one atomic transaction
    /// @dev This function can only be called the Across SpokePool on this network
    /// @param tokenSent The address of the token that was received
    /// @param amount The amount of tokens received
    /// @param * - unused(relayer) The address of the relayer who is executing this message
    /// @param message The composed message payload in bytes
    function handleV4AcrossMessage(
        address tokenSent,
        uint256 amount,
        address,
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
